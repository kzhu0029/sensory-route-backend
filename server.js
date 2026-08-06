const express = require("express");
const cors = require("cors");

const routesRouter = require("./routes/routes");
const pedestrianRouter = require("./routes/pedestrian");
const refugeRouter = require("./routes/refuges");

const app = express();
const PORT = process.env.PORT || 3000;

// Allow requests from the frontend
app.use(cors());

app.use(express.json());

app.get("/", (req, res) => {
  res.send("FIT5120 Backend is running!");
});

app.use("/api/routes", routesRouter);
app.use("/api/pedestrian", pedestrianRouter);
app.use("/api/refuges", refugeRouter);

// Simple error handler
app.use((err, req, res, next) => {
  console.error(err);

  res.status(500).json({
    error: "Internal server error",
  });
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});