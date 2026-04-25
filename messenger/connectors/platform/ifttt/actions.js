const db = require('../../core/db');
const utility = require('../../core/utility.js');

let notify = require('./realtime');

const platform = "ifttt";

const device_connector = require('../../connectors/device/device-connector');
const cloudDeviceConnector = require('../../connectors/device/cloud-device-connector');
const hooks = require('../../hooks');

function actions(req, res) {
    const token = utility.extractAccessToken(req);
    utility.validateAccessToken(platform, token).then(result => {
        if(result) {
           
            // Required request body parameters
            let {actionFields, user} = req.body;

            let ifttt_source = req.body.ifttt_source;

            // Validate that these required parameters aren't null
            if (actionFields == null || user == null) {
                return res.status(400).send({
                    "errors": [
                        {
                            "message": "One of the required parameters is not provided"
                        }
                    ]
                });
            }

            let device_id = actionFields.id_of_the_device;

            if (device_id == null) {
                return res.status(400).send({
                    "errors": [
                        {
                            "message": "Device id not specified."
                        }
                    ]
                });
            }

            let value, attribute;
           
            // Find out what action to run
            switch (req.params.action) {
                case 'turn_switch_on': {
                    value = "ON";
                    attribute = "switch";
                    break;
                }
                case 'turn_switch_off': {
                    value = "OFF";
                    attribute = "switch";
                    break;
                }
                case 'unlock_lock': {
                    value = "ON";
                    attribute = "lock";
                    break;
                }
                case 'lock_lock': {
                    value = "OFF";
                    attribute = "lock";
                    break;
                }
                case 'open_valve': {
                    value = "ON";
                    attribute = "valve";
                    break;
                }
                case 'close_valve': {
                    value = "OFF";
                    attribute = "valve";
                    break;
                }
                default: {
                    return res.status(401).send({
                        "errors": [
                            {
                                "message": "Unknown route"
                            }
                        ]
                    });
                }

            }


            db.getDevice(device_id).then((device) => {
                if(!device) {
                    throw new Error("Cannot find the requested device");
                }
                let promises = [];
                const commandContext = {
                    platform: platform,
                    device: {uid: device_id, label: device.label},
                    attribute: attribute,
                    value: value,
                    is_cloud_device: device.thingTypeUID === "cloud:device",
                    raw: {action: req.params.action, body: req.body},
                };
                promises.push(db.insertCommand({
                    device: {uid: device_id, label: device.label},
                    attribute: attribute,
                    value: value,
                    platform: platform,
                }));
                if(device.thingTypeUID === "cloud:device") {
                    let cloudValue = value;
                    if(value === "ON") cloudValue = "on";
                    if(value === "OFF") cloudValue = "off";
                    promises.push(hooks.handlePlatformCommand(commandContext, () => {
                        return cloudDeviceConnector.sendCommandToDevice(device_id, cloudValue);
                    }));
                    return Promise.allSettled(promises);
                }
                return device_connector.getDevice(device_id).then(localdevice => {
                    promises.push(hooks.handlePlatformCommand(commandContext, () => {
                        let sendPromises = [];
                        if(localdevice) {
                            for(let item of localdevice.items) {
                                if(item.category === attribute) {
                                    sendPromises.push(device_connector.sendCommandToItem(item, value));
                                }
                            }
                        }
                        return Promise.allSettled(sendPromises);
                    }));
                    return Promise.allSettled(promises);
                });
            })
            .then(() => {
                return db.getTriggerIdentities(device_id);
            })
            .then((trigger_identities) => {

                console.log("Device data successfully changed (actions)");

                // Notifies IFTTT that device status has changed if it is needed
                if (trigger_identities != null && trigger_identities.length != 0) {
                    return notify(trigger_identities);
                } else {
                    // console.log("Device data not changed");
                }
            })
            .then(() => {
                return res.status(200).send({
                    "data": [{
                        "id": device_id
                    }],
                });
            })
            .catch((err) => {
                console.log(err)
                return res.status(500).send({
                    "errors": [
                        {
                            "message": "Failed to execute command"
                        }
                    ]
                });
            });

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
}

module.exports = actions;
