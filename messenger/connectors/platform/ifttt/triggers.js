let db = require('../../core/db.js');
let utility = require('../../core/utility');
let notify = require('./realtime');

const platform = "ifttt";

// trigger endpoint routes
function triggers(req, res) {
    // console.log(JSON.stringify(req.headers));
    // console.log(JSON.stringify(req.params.trigger));
    const token = utility.extractAccessToken(req);
    utility.validateAccessToken(platform, token).then(async (result) => {
        if(result) {
            // Required request body parameters
            let {trigger_identity, triggerFields, user} = req.body;

            // Default max number of items returned is 50
            let limit = req.body.limit === undefined ? 50 : req.body.limit;

            if (triggerFields == null || trigger_identity == null || user == null) {
                return res.status(400).send({
                    "errors": [
                        {
                            "message": "One of the required parameters is not provided"
                        }
                    ]
                });
            }

            let ifttt_source = req.body.ifttt_source;

            let device_id = triggerFields.id_of_the_device;

            if (!device_id) {
                return res.status(400).send({
                    "errors": [
                        {
                            "message": "Device type not specified"
                        }
                    ]
                });
            }

            // Define response object
            let data = [];

            // Stores events that match endpoint
            let events = [];

            // Find out what trigger to run
            switch (req.params.trigger) {
                case 'switch_on': {
                    // Handle with async await or then
                    events = await db.getEvents(device_id, "switch", "ON", limit, "=");
                    break;
                }
                case 'switch_off': {
                    events = await db.getEvents(device_id, "switch", "OFF", limit, "=");
                    break;
                }
                case 'contact_open': {
                    events = await db.getEvents(device_id, "contact", "OPEN", limit, "=");
                    break;
                }
                case 'contact_closed': {
                    events = await db.getEvents(device_id, "contact", "CLOSED", limit, "=");
                    break;
                }
                case 'power_changed': {
                    events = await db.getEvents(device_id, "power", null, limit, "=");
                    break;
                }
                case 'temperature_changed': {
                    events = await db.getEvents(device_id, "temperature", null, limit, "=");
                    break;
                }
                case 'temperature_over_specified': {
                    let threshold = triggerFields.threshold_temperature;
                    events = await db.getEvents(device_id, "temperature", threshold, limit, ">");
                    break;
                }
                case 'temperature_under_specified': {
                    let threshold = triggerFields.threshold_temperature;
                    events = await db.getEvents(device_id, "temperature", threshold, limit, "<");
                    break;
                }
                case 'motion_active': {
                    events = await db.getEvents(device_id, "motion", "active", limit, "=");
                    break;
                }
                case 'motion_inactive': {
                    events = await db.getEvents(device_id, "motion", "inactive", limit, "=");
                    break;
                }
                case 'illuminance_changed': {
                    events = await db.getEvents(device_id, "illuminance", null, limit, "=");
                    break;
                }
                case 'level_changed': {
                    events = await db.getEvents(device_id, "level", null, limit, "=");
                    break;
                }
                case 'is_dry': {
                    events = await db.getEvents(device_id, "water", "dry", limit, "=");
                    break;
                }
                case 'is_wet': {
                    events = await db.getEvents(device_id, "water", "wet", limit, "=");
                    break;
                }
                case 'humidity_changed': {
                    events = await db.getEvents(device_id, "humidity", null, limit, "=");
                    break;
                }
                default: {
                    return res.status(401).send({
                        "errors": [
                            {
                                "message": "Unknown item type"
                            }
                        ]
                    });
                }
            }

            events.forEach((event) => {
                data.push({
                    // Must be a valid ISOString
                    created_at: Object(new Date(Math.round(event.timestamp)).toISOString()),
                    device_status: event.value,
                    device_id: event.device_id,
                    meta: {
                        id: event.id.toString(),
                        // This returns a unix timestamp in seconds.
                        timestamp: Math.floor(event.timestamp/1000)
                    }
                });
            })

            // Keeps track of whether we've ever added the trigger identity
            let new_trigger_identity = false;

            // Set Trigger Identity if not already in the database
            db.getTriggerIdentity(trigger_identity)
                .then((row) => {
                    if (!row) {
                        return db.setTriggerIdentity(device_id, trigger_identity);
                    }
                })
                .then(async (triggerIdentitySet) => {
                    // If this is the first time setting the specified trigger identity,
                    // notify realtime endpoint
                    if (triggerIdentitySet) {
                        let trigger_identies = await db.getTriggerIdentities(device_id);
                        if (trigger_identies != null && trigger_identies.length > 0) {
                            new_trigger_identity = true;
                            return notify(trigger_identies) 
                        }
                    }
                })
                .then(() => {
                    // Return empty data array since we want to wait until IFTTT polls this trigger again
                    // this time with the the X-IFTTT-Realtime: 1 header
                    // If we don't do this, then IFTTT notes the change in data but might not actually do anything
                    // since it tries to change the state of the devices before the trigger_identity might be registered
                    if (new_trigger_identity && (req.headers == null || req.headers['ifttt-test-mode'] != "1")) {
                        return res.status(200).send({data: []});
                    }

                    return res.status(200).send({
                        "data": data,
                    });
                })

        } else {
            return res.status(401).send({
                "errors": [
                    {
                        "message": "The access token is invalid!"
                    }
                ]
            })
        }
    });
}

// trigger endpoint routes
function deleteTriggerID(req, res) {
    const token = utility.extractAccessToken(req);
    utility.validateAccessToken(platform, token).then(async (result) => {
        if(result) {
            let trigger_identity = req.params.tid;
            if (req.params.trigger == null || req.params.tid == null) {
                return res.status(400).send({
                    "errors": [
                        {
                            "message": "One of the required parameters is not provided"
                        }
                    ]
                });
            }
            
            return db.removeTriggerID(trigger_identity)
                .then(() => {
                    return res.status(200).send();
                });
        } else {
            return res.status(401).send({
                "errors": [
                    {
                        "message": "The access token is invalid!"
                    }
                ]
            })
        }
    });
}

exports.deleteTriggerID = deleteTriggerID;
exports.triggers = triggers;
