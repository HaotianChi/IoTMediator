const express = require('express');
const router = express.Router();
const db = require('../../../messenger/core/db');
const os = require('os');
const path = require('path');
const honeywell_api = require('../../../messenger/connectors/device/honeywell-api');
const honeywell_config = require('../../../config/default').cloud_device_connector.honeywell;

const vendor = "honeywell";


router.get("/redirect", (req, res) => {
    const code = req.query.code;
    //console.log("code:", code);
    res.send("<h2>You have successfully authorized IoTMediator to access your devices!</h2><br><h2>Now you can close this page.</h2>");
    res.status(200).end();
    honeywell_api.request_tokens(code).then(data => {
        //console.log("honeywell tokens:", data);
        token = {};
        token.client_id = honeywell_config.apikey;
        token.platform = vendor;
        token.keyword = "";
        token.access_token = data.access_token;
        token.refresh_token = data.refresh_token;
        token.expires_in = data.expires_in;
        token.token_url = "";
        token.callback_url = "";
        db.updatePToken(token);
    });
});


module.exports = router;
