require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const admin = require("firebase-admin");
const port = process.env.PORT || 3000;
const decoded = Buffer.from(process.env.FB_SERVICE_KEY, "base64").toString(
  "utf-8"
);
const serviceAccount = JSON.parse(decoded);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const app = express();

// middleware
app.use(
  cors({
    origin: [process.env.CLIENT_DOMAIN],
    credentials: true,
    optionSuccessStatus: 200,
  })
);
app.use(express.json());

// jwt middlewares
const verifyJWT = async (req, res, next) => {
  const token = req?.headers?.authorization?.split(" ")[1];
  console.log(token);
  if (!token) return res.status(401).send({ message: "Unauthorized Access!" });
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    req.tokenEmail = decoded.email;
    console.log(decoded);
    next();
  } catch (err) {
    console.log(err);
    return res.status(401).send({ message: "Unauthorized Access!", err });
  }
};

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(process.env.MONGODB_URI, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    const db = client.db("Jurnext-1");
    const usersCollection = db.collection("Users");
    const ticketsCollection = db.collection("Tickets");
    const bookedTicketsCollection = db.collection("Booked_Tickets");

    // save or update user in database
    app.post("/user", async (req, res) => {
      const userData = req.body;

      userData.created_at = new Date().toISOString();
      userData.last_loggedIn = new Date().toISOString();
      userData.role = "customer";

      const query = { email: userData.email };
      const alreadyExist = await usersCollection.findOne(query);

      if (alreadyExist) {
        const result = await usersCollection.updateOne(query, {
          $set: {
            last_loggedIn: new Date().toISOString(),
          },
        });
        return res.send(result);
      }

      const result = await usersCollection.insertOne(userData);
      res.send(result);
    });

    //get all users from database [Admin only]
    app.get("/users", verifyJWT, async (req, res) => {
      const result = await usersCollection.find().toArray();
      res.send(result);
    });

    //update user role [admin only]
    app.patch("/update-role", verifyJWT, async (req, res) => {
      try {
        const { id, role } = req.body;

        if (!id) {
          return res.status(400).send({ message: "User ID is required" });
        }

        const filter = { _id: new ObjectId(id) };
        const updateDoc = { $set: { role: role } };

        const result = await usersCollection.updateOne(filter, updateDoc);
        res.send(result);
      } catch (err) {
        res
          .status(500)
          .send({ message: "Failed to update role", error: err.message });
      }
    });

    //make a vendor fraud [admin only]
    app.patch("/users/mark-fraud/:id", verifyJWT, async (req, res) => {
      const id = req.params.id;

      const result = await usersCollection.updateOne(
        { _id: new ObjectId(id) },
        {
          $set: {
            fraud: true,
          },
        }
      );
      res.send(result);
    });

    //remove fraud field to the vendor [admin only]
    app.patch("/users/unmark-fraud/:id", verifyJWT, async (req, res) => {
      const id = req.params.id;

      const result = await usersCollection.updateOne(
        { _id: new ObjectId(id) },
        {
          $unset: {
            fraud: "",
          },
        }
      );
      res.send(result);
    });

    //Update advertise status and filter <= 6 tickets for advertise [admin only]
    app.patch("/advertise-ticket/:id", verifyJWT, async (req, res) => {
      const { id } = req.params;
      const { advertise } = req.body;

      const advertisedCount = await ticketsCollection.countDocuments({
        advertise: true,
      });

      if (advertisedCount >= 6) {
        return res.status(400).send({
          message: "Limit reached! You cannot advertise more than 6 tickets.",
        });
      }

      const filter = { _id: new ObjectId(id) };
      const updateDoc = {
        $set: { advertise },
      };

      const result = await ticketsCollection.updateOne(filter, updateDoc);
      res.send(result);
    });

    //send 1 data to database [Seller Only]
    app.post("/tickets", async (req, res) => {
      const plantData = req.body;
      const result = await ticketsCollection.insertOne(plantData);
      res.send(result);
    });

    //get all approved ticket Data from Database [common access]
    app.get("/approved-tickets", async (req, res) => {
      const result = await ticketsCollection
        .find({ status: "approved" })
        .toArray();
      res.send(result);
    });

    //get all ticket Data from Database [Admin only]
    app.get("/tickets", verifyJWT, async (req, res) => {
      const result = await ticketsCollection.find().toArray();
      res.send(result);
    });

    // update the ticket status by Admin [Admin only]
    app.patch("/tickets/:id", verifyJWT, async (req, res) => {
      const id = req.params.id;
      const { status } = req.body;

      try {
        const query = { _id: new ObjectId(id) };
        const updateDoc = {
          $set: {
            status: status,
          },
        };

        const result = await ticketsCollection.updateOne(query, updateDoc);

        if (result.modifiedCount > 0) {
          res.send(result);
        } else {
          res.status(404).send({ message: "Status update failed" });
        }
      } catch (error) {
        res.status(500).send({ message: "Internal Server Error" });
      }
    });

    //get 1 ticket Data from Database [common access]
    app.get("/tickets/:id", async (req, res) => {
      const { id } = req.params;
      const result = await ticketsCollection.findOne({ _id: new ObjectId(id) });
      res.send(result);
    });

    //send 1 data to database [common access]
    app.post("/book-ticket", async (req, res) => {
      const ticketBookingData = req.body;
      const result = await bookedTicketsCollection.insertOne(ticketBookingData);
      res.send(result);
    });

    //get all booked ticket data from database [customer only]
    app.get("/booked-tickets", verifyJWT, async (req, res) => {
      const email = req.tokenEmail;

      try {
        const result = await bookedTicketsCollection
          .aggregate([
            {
              $match: { "customer.email": email },
            },
            {
              $addFields: {
                convertedTicketID: { $toObjectId: "$ticketID" },
              },
            },
            {
              $lookup: {
                from: "Tickets",
                localField: "convertedTicketID",
                foreignField: "_id",
                as: "ticketDetails",
              },
            },
            {
              $unwind: "$ticketDetails",
            },
            {
              $project: {
                convertedTicketID: 0,
                ticketID: 0,
                customer: 0,
                "ticketDetails.perks": 0,
                "ticketDetails.transport": 0,
                "ticketDetails.quantity": 0,
                "ticketDetails.vendor": 0,
                "ticketDetails._id": 0,
              },
            },
          ])
          .toArray();

        res.send(result);
      } catch (error) {
        console.error("Aggregation Error:", error);
        res
          .status(500)
          .send({ message: "Failed to fetch booked tickets with details." });
      }
    });

    //get all added ticket of a vendor, verify vendor using email [vendor only]
    app.get("/added-tickets", verifyJWT, async (req, res) => {
      const email = req.tokenEmail;
      const result = await ticketsCollection
        .find({ "vendor.email": email })
        .toArray();
      res.send(result);
    });

    //get all booking request data for a verified vendor [vendor only]
    app.get("/requested-booking", verifyJWT, async (req, res) => {
      const email = req.tokenEmail;
      const result = await bookedTicketsCollection
        .aggregate([
          { $match: { "vendor.email": email } },
          {
            $addFields: {
              convertedID: { $toObjectId: "$ticketID" },
            },
          },
          {
            $lookup: {
              from: "Tickets",
              localField: "convertedID",
              foreignField: "_id",
              as: "joinedTicket",
            },
          },
          { $unwind: "$joinedTicket" },
          {
            $project: {
              _id: 1,
              customer: 1,
              vendor: 1,
              status: 1,
              quantity: 1,
              ticketPrice: "$joinedTicket.price",
              ticketTitle: "$joinedTicket.title",
            },
          },
        ])
        .toArray();
      res.send(result);
    });

    // update the booked ticket status by a verified vendor [vendor only]
    app.patch("/booking-status/:id", verifyJWT, async (req, res) => {
      const id = req.params.id;
      const { status } = req.body;

      try {
        const query = { _id: new ObjectId(id) };
        const updateDoc = {
          $set: {
            status: status,
          },
        };

        const result = await bookedTicketsCollection.updateOne(
          query,
          updateDoc
        );

        if (result.modifiedCount > 0) {
          res.send(result);
        } else {
          res.status(404).send({ message: "Status update failed" });
        }
      } catch (error) {
        res.status(500).send({ message: "Internal Server Error" });
      }
    });

    // Send a ping to confirm a successful connection
    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!"
    );
  } finally {
    // Ensures that the client will close when you finish/error
  }
}
run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("Hello from Server..");
});

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
