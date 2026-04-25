let express = require('express');
let router = express.Router();
let db = require('../core/db.js');
const config = require('../../config/default');
const utility = require('../core/utility.js');

const platform = 'ifttt'

const testSetupRoute = require('./ifttt/testsetup');
const triggerRoute = require('./ifttt/triggers').triggers;
const actionRoute = require('./ifttt/actions');
const triggerOptions = require('./ifttt/dynamic-dropdown-triggers');
const actionOptions = require('./ifttt/dynamic-dropdown-actions');
const deleteTriggerID = require('./ifttt/triggers').deleteTriggerID;

// check service key when the status endpoint is called
function checkServiceKey(req, res, next) {
    const key = req.get("IFTTT-Service-Key");
    if (key !== config.ifttt.service_key) {
      res.status(401).send();
    } else {
        next();
    }
}

// handle service status endpoint request
router.get('/v1/status', checkServiceKey, (req, res) => {
    res.status(200).send();
});

// handle test/setup endpoint request
router.post('/v1/test/setup', checkServiceKey, testSetupRoute);


// trigger endpoint routes
router.post('/v1/triggers/:trigger', triggerRoute);

// action endpoint routes
router.post('/v1/actions/:action', actionRoute);

// trigger dynamic options/dropdown route
router.post('/v1/triggers/:trigger/fields/:field/options', triggerOptions);

// actions dynamic options/dropdown route
router.post('/v1/actions/:action/fields/:field/options', actionOptions);

// Deleting Trigger ID endpoint
router.delete('/v1/triggers/:trigger/trigger_identity/:tid', deleteTriggerID);

// handle request to user info.
router.get('/v1/user/info', async (req, res) => {
    console.log("/user/info is requested");
    // verifying access token
    const token = utility.extractAccessToken(req);
    utility.validateAccessToken(platform, token).then(result => {
        console.log("validation result:", result);
        if(result) {
            db.getDefaultAccount().then(account => {
                console.log(account);
                res.status(200).send({
                    "data": { name: account.username, id: account.uid },
                });
            })
        } else {
            res.status(401).send({
                "errors": [
                    {
                        "message": "The access token is invalid!"
                    }
                ]
            })
        }
    });
});



module.exports = router;
