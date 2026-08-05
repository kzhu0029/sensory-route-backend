const express = require("express");

const routesRouter = require("./routes/routes");
const pedestrianRouter = require("./routes/pedestrian");
const refugeRouter = require("./routes/refuges");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());


app.get("/", (req, res) => {
  res.send("FIT5120 Backend is running!");
});


app.use("/api/routes", routesRouter);
app.use("/api/pedestrian", pedestrianRouter);
app.use("/api/refuges", refugeRouter);


app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});