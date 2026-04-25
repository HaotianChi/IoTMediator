const express = require("express");


const router = express.Router();

// Home page
router.get("/", (req, res) => {
  res.render("website/profile");
});


module.exports = router;