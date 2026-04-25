const express = require("express");


const router = express.Router();

// Log a user out
router.get("/logout", (req, res) => {
  req.logout();
  res.redirect("/");
});

router.get("/test", (req, res) => {
  res.render('website/echo', {data: JSON.stringify(req.user.profile)});
})


module.exports = router;