let db = require('../../core/db.js');
let utility = require('../../core/utility');
let notify = require('./realtime');

const platform = "ifttt";

function dynamic_dropdown(req, res) {

    let attribute;
    const token = utility.extractAccessToken(req);
    utility.validateAccessToken(platform, token).then(async (result) => {
        if(result) {


            let field = req.params.field;
            
            if (field != "id_of_the_device") {
                return res.status(401).send({
                    "errors": [
                        {
                            "message": "Unknown action field."
                        }
                    ]
                });
            }

            console.log(req.params.action);
            switch (req.params.action) {
                case 'turn_switch_on': {
                    attribute = "switch";
                    return db.getDeviceIDsWithAttrib(attribute);
                }
                case 'turn_switch_off': {
                    attribute = "switch";
                    return db.getDeviceIDsWithAttrib(attribute);
                }
                case 'unlock_lock': {
                    attribute = "lock";
                    return db.getDeviceIDsWithAttrib(attribute);
                }
                case 'lock_lock': {
                    attribute = "lock";
                    return db.getDeviceIDsWithAttrib(attribute);
                }
                case 'open_valve': {
                    attribute = "valve";
                    return db.getDeviceIDsWithAttrib(attribute);
                }
                case 'close_valve': {
                    attribute = "valve";
                    return db.getDeviceIDsWithAttrib(attribute);
                }
                default: {
                    console.log("Default");
                    return res.status(401).send({
                        "errors": [
                            {
                                "message": "Unknown item type"
                            }
                        ]
                    });
                }
            }
        } else {
            console.log("Wrong authorization");
            return res.status(401).send({
                "errors": [
                    {
                        "message": "The access token is invalid!"
                    }
                ]
            });
        }
    })
    .then((ids) => {
        if (Array.isArray(ids)) {
            let values = [];
            console.log(ids);
            ids.forEach(id => {
                values.push({
                    "label": id,
                    "value": id
                });
            });
            return res.status(200).send({
                "data": [
                    {
                        "label": attribute,
                        "values": values
                    }
                ]
            });
        }

    });
}

module.exports = dynamic_dropdown;
