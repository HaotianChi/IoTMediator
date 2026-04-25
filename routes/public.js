const express = require("express");


const router = express.Router();

// Home page
router.get("/", (req, res) => {
  res.render("website/index");
});

router.get("/index", (req, res) => {
    res.render("website/index");
});

module.exports = router;