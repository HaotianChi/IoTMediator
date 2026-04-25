const express = require('express');
const router = express.Router();
const db = require('../../../messenger/core/db');
const os = require('os');
const path = require('path');
const hue_api = require('../../../messenger/connectors/device/hue-api');
const hue_config = require('../../../config/default').cloud_device_connector.hue;

const vendor = "hue";


router.get("/redirect", (req, res) => {
    const code = req.query.code;
    //const state = req.query.state;
    //console.log("code:", code);
    //console.log("state:", state);
    res.send("<h2>You have successfully authorized IoTMediator to access your devices!</h2><br><h2>Now you can close this page.</h2>");
    res.status(200).end();

    //const authorizationCode = code + "&state=" + state;
    //console.log(code);
    hue_api.request_tokens(code).then(data => {
        //console.log("Hue tokens:", data);
        token = {};
        token.client_id = data.clientId;
        token.client_secret = data.clientSecret;
        token.platform = vendor;
        token.keyword = data.username;
        token.access_token = data.tokens.access.value;
        token.refresh_token = data.tokens.refresh.value;
        token.expires_in = data.tokens.access.expiresAt;
        token.token_url = "";
        token.callback_url = "";
        db.updatePToken(token);
    });
});


module.exports = router;
