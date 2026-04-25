const express = require("express");


const router = express.Router();

router.get("/callback", (req, res) => {

  res.redirect("/");
});


module.exports = router;