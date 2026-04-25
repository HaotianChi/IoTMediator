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
                            "message": "Unknown trigger field."
                        }
                    ]
                });
            }

            // console.log("Trigger: " + req.params.trigger);

            switch (req.params.trigger) {
                case 'contact_open': {
                    attribute = "contact";
                    return db.getDeviceIDsWithAttrib(attribute);
                }
                case 'contact_closed': {
                    attribute = "contact";
                    return db.getDeviceIDsWithAttrib(attribute);
                }
                case 'power_changed': {
                    attribute = "power";
                    return db.getDeviceIDsWithAttrib(attribute);
                }
                case 'temperature_changed': {
                    attribute = "temperature";
                }
                case 'temperature_over_specified': {
                    attribute = "temperature";
                    return db.getDeviceIDsWithAttrib(attribute);
                }
                case 'temperature_under_specified': {
                    attribute = "temperature";
                    return db.getDeviceIDsWithAttrib(attribute);
                }
                case 'motion_active': {
                    attribute = "motion";
                    return db.getDeviceIDsWithAttrib(attribute);
                }
                case 'motion_inactive': {
                    attribute = "motion";
                    return db.getDeviceIDsWithAttrib(attribute);
                }
                case 'illuminance_changed': {
                    attribute = "illuminance";
                    return db.getDeviceIDsWithAttrib(attribute);
                }
                case 'level_changed': {
                    attribute = "level";
                    return db.getDeviceIDsWithAttrib(attribute);
                }
                case 'is_dry': {
                    attribute = "water";
                    return db.getDeviceIDsWithAttrib(attribute);
                }
                case 'is_wet': {
                    attribute = "water";
                    return db.getDeviceIDsWithAttrib(attribute);
                }
                case 'humidity_changed': {
                    attribute = "humidity";
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
                    break;
                }
            }
        } else {
            // console.log("Wrong authorization");
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
