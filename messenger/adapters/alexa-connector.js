let express = require('express');
let router = express.Router();
let db = require('../core/db.js');
const config = require('../../config/default');
const utility = require('../core/utility.js');
const deviceConnector= require('../connectors/device/device-connector');
const cloudDeviceConnector = require('../connectors/device/cloud-device-connector');
const request = require('request');
const alexa_api = require('./alexa-api');
const hooks = require('../hooks');

const platform = 'alexa';

const no_authentication = config.no_authentication;

// a simulated devices for testing
let outlet1 = {
    discovery: {
        device_id: 'outlet_id',
        label: 'Bedroom Outlet',
        target_platform: 'alexa',
        attributes: ['switch'],
        is_cloud_device: 0,
        source: 'Smart Device Company'
    },
    states:{
        switch: 'ON'
    }
}

let motion1 = {
    discovery: {
        device_id: 'motion_id',
        label: 'Bedroom Motion',
        target_platform: 'alexa',
        attributes: ['motion'],
        is_cloud_device: 0,
        source: 'Smart Device Company'
    },
    states:{
        motion: 'active'
    }
}



function extractAccessToken(req) {
    try {
        let authorization_base64 = req.headers.authorization.split(' ')[1];
        let authorization = Buffer.from(authorization_base64, 'base64').toString('ascii');
        return authorization; 
    } catch (error) {
        console.log(error);
        return undefined;
    }
}



// Device Discovery
router.get('/integration/v1/discovery', (req, res) => {
    // db.getDevices().then(devices => {
    //     res.setHeader('Content-Type', 'application/json');
    //     res.status(200).send({devices: devices});
    // })

    
    db.getAuthenticationToken(platform).then(data => {
        if(extractAccessToken(req) === data.access_token || no_authentication === true) {
            db.getDevices().then(devices => {
                const discoveryDevices = (devices || [])
                    .filter(device => device.target_platform === platform)
                    .map(device => ({
                        device_id: device.device_id,
                        label: device.label,
                        target_platform: device.target_platform,
                        attributes: device.attributes,
                        is_cloud_device: device.is_cloud_device,
                        source: device.source,
                    }));
                res.status(200).send({devices: discoveryDevices});
            }).catch(err => {
                console.error("Discovery failed:", err);
                res.status(500).send({status: 'fail', message: 'Discovery failed'});
            });
        }
        else {
            res.status(401).send({status: 'fail', message: 'Access token is invalid'});
        }
    });
    
    
});

// Query Device State
router.get('/integration/v1/state/:deviceId/:attribute', (req, res) => {
    db.getAuthenticationToken(platform).then(data => {
        if(extractAccessToken(req) === data.access_token || no_authentication === true) {
            db.getState(req.params.deviceId, req.params.attribute).then(row => {
                let value = row.value;
                res.setHeader('Content-Type', 'application/json');
                res.status(200).send({state: value});
            });
        }
        else {
            res.status(401).send({status: 'fail', message: 'Access token is invalid'});
        }
    });
});


// Query All States of a device
router.get('/integration/v1/states/:deviceId', (req, res) => {
    db.getAuthenticationToken(platform).then(data => {
        if(extractAccessToken(req) === data.access_token || no_authentication === true) {
            db.getDeviceStates(req.params.deviceId).then(rows => {
                let states = [];
                if(rows) {
                    for(let row of rows) {
                        states.push({
                            device_id: row.device_id,
                            label: row.label,
                            attribute: row.attribute,
                            value: row.value,
                        });
                    }
                }
                res.setHeader('Content-Type', 'application/json');
                res.status(200).send({states: states});
            }).catch(err => {
                console.error("Query device states failed:", err);
                res.status(500).send({status: 'fail', message: 'Query states failed'});
            });
        }
        else {
            res.status(401).send({status: 'fail', message: 'Access token is invalid'});
        }
    });


});

// Control Device
router.post('/integration/v1/command', (req, res) => {
    // db.getDevice(req.body.deviceId).then(device => {
    //     if(!device) {
    //         console.error("Cannot find the requested device!");
    //         res.status(404).send("Cannot find the requested device!");
    //     }

    //     if(device.thingTypeUID === "cloud:device") { // vendor-connected device
    //         res.status(200).send({status: 'success'});
    //     } else { // local-connected device
    //         deviceConnector.getDevice(req.body.deviceId).then(localdevice => {
    //             const itemCommand = convertToItemCommand(req.body); // pass the post body, not the command
    //             if(itemCommand.method) {
    //                 for(let item of localdevice.items) {
    //                   if(item.category === itemCommand.category) {
    //                     deviceConnector.sendCommandToItem(item, itemCommand.method);
    //                     res.status(200).send();
    //                   }
    //                 }
    //             } else {
    //                 console.error("The requested device does not support the command!");
    //                 res.status(404).send("The requested device does not support the command!");
    //             }
    //         });
    //     }
    // })


    db.getAuthenticationToken(platform).then(data => {
        if(extractAccessToken(req) === data.access_token || no_authentication === true) {
            const deviceId = req.body.deviceId;
            const itemCommand = convertToItemCommand(req.body); // pass the post body, not the command
            if(!deviceId || !itemCommand.method) {
                res.status(400).send({status: 'fail', message: 'Invalid command'});
                return;
            }
            db.getDevice(deviceId).then(device => {
                const commandContext = {
                    platform: platform,
                    device: {uid: deviceId, label: device ? device.label : deviceId},
                    attribute: itemCommand.category,
                    value: itemCommand.method,
                    is_cloud_device: device ? device.thingTypeUID === "cloud:device" : false,
                    raw: {body: req.body},
                };
                if(device) {
                    db.insertCommand({
                        device: {uid: deviceId, label: device.label},
                        attribute: itemCommand.category,
                        value: itemCommand.method,
                        platform: platform,
                    }).catch(err => {
                        console.error(err);
                    });
                }
                return hooks.handlePlatformCommand(commandContext, () => {
                    if(!device) {
                        if(deviceId === outlet1.discovery.device_id) {
                            outlet1.states.switch = itemCommand.method;
                        }
                        return;
                    }
                    if(device.thingTypeUID === "cloud:device") {
                        let cloudValue = itemCommand.method;
                        if(itemCommand.method === "ON") cloudValue = "on";
                        if(itemCommand.method === "OFF") cloudValue = "off";
                        return cloudDeviceConnector.sendCommandToDevice(deviceId, cloudValue);
                    }
                    return deviceConnector.getDevice(deviceId).then(localdevice => {
                        let sendPromises = [];
                        if(localdevice) {
                            for(let item of localdevice.items) {
                                if(item.category === itemCommand.category) {
                                    sendPromises.push(deviceConnector.sendCommandToItem(item, itemCommand.method));
                                }
                            }
                        }
                        return Promise.allSettled(sendPromises);
                    });
                }).then(() => {
                    res.setHeader('Content-Type', 'application/json');
                    res.status(200).send({status: 'success'});
                });
            }).catch(err => {
                console.error(err);
                res.status(500).send({status: 'fail', message: 'Command handling failed'});
            });
        }
        else {
            res.status(401).send({status: 'fail', message: 'Access token is invalid'});
        }
    });

});



// Notify code and Bear Token - Lambda function notify of the code that is used to access Alexa
// and the bearer token (for authenticating Alexa)
router.post('/integration/v1/authorization-directive', (req, res) => {
    const bearerToken = req.body.token; // access token for authenticating Alexa
    const body = {
        grant_type: 'authorization_code',
        code: req.body.code,
        // client_id: config.alexa.mp_client_id,
        // client_secret: config.alexa.mp_client_secret
    };
    const url = config.alexa.lwa_token_url;
    request.post(url, 
        {
            auth: {
                user:config.alexa.client_id,
                password: config.alexa.client_secret
            },
            json: body
        }, (err, res1, body1) => {
        if (err) {
            return console.error(err);
        }
        let token = {};
        token.platform = platform;
        token.client_id = config.alexa.client_id;
        token.access_token = body1.access_token;
        token.refresh_token = body1.refresh_token;
        token.expires_in = body1.expires_in;
        db.updatePToken(token).then(() => {
            db.addAlexaAuthenticationToken(config.alexa.mp_client_id, platform, bearerToken).then(() => {
                console.log("Succeed to handle the AcceptGrant directive");
                res.status(200).send({status: 'success'});

            });
        }).catch(err => {
            console.error("#### Error: ", err.message);
            res.status(500).send({status: 'Failed to handle the AcceptGrant directive'})
        })
    });  
});



// // Change Report
// function ReportStateChange(event) {

// }







function convertToItemCommand(reqBody) {
    const method = reqBody.command;
    const capability = reqBody.capability;
    const argument = reqBody.argument;
    var itemCommand = {category: undefined, method: undefined, arguments: undefined};
    switch(method) {
        case 'on':
            itemCommand.category = 'switch';
            itemCommand.method = 'ON';
          break;
        case 'off':
            itemCommand.category = 'switch';
            itemCommand.method = 'OFF';
          break;
        case 'lock': // LOCK <-> OFF, UNLOCK <-> ON
            itemCommand.category = 'lock';
            itemCommand.method = 'OFF';     
          break;
        case 'unlock':
            itemCommand.category = 'lock';
            itemCommand.method = 'ON';
          break;
        case 'setBrightness':
            itemCommand.category = 'level';
            itemCommand.method = argument;
          break;
        // case 'close':
        //   break;
        default:
          console.error('unknown command: ', method);
    }
    return itemCommand;
}


function command2CloudCommand(command) {
    const method = command.command;
    const capability = command.capability;
    const arguments = command.arguments;
    var cloudCommand = {category: undefined, method: undefined, arguments: undefined};
    switch(method) {
        case 'on':
          if(capability === 'st.switch') {
            cloudCommand.category = 'switch';
            cloudCommand.method = 'on';
          }
          break;
        case 'off':
          if(capability === 'st.switch') {
            cloudCommand.category = 'switch';
            cloudCommand.method = 'off';
          }
          break;
        // case 'lock':
        //   break;
        // case 'unlock':
        //   break;
        // case 'open':
        //   break;
        // case 'close':
        //   break;
        default:
          console.error('unknown command: ', method);
    }
    return cloudCommand;
}


module.exports = router;


if (typeof require !== 'undefined' && require.main === module) {
    db.getAuthenticationToken(platform).then(data => {
        console.log(data);
    })
}
