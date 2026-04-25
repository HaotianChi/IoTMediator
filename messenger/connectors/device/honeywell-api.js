const request = require('request');
const fs = require('fs');
const honeywell_config = require('../../config/default').cloud_device_connector.honeywell;


function request_authorize() {
    console.log('========================================================================================================================')
    console.log('Please visit this link to authorize IoTMediator to access your Honeywell devices:\n', honeywell_config.AUTHORIZATION_URL);
    console.log('========================================================================================================================')
}

function request_tokens(code) {
    return new Promise((resolve, reject) => {
        const token_url = 'https://api.honeywell.com/oauth2/token';
        let data = {
            grant_type:'authorization_code', 
            code: code,
            redirect_uri: honeywell_config.redirectUri,
        }; 
        let headers = {
            'authorization': `Basic ${honeywell_config.credential_base64}`,
            'content-type': "application/x-www-form-urlencoded",
        };
        request.post({
            url: token_url,
            headers: headers,
            form: data,
        }, (err, res, body) => {
            if(err) {
                reject(err);
            } else {
                resolve(JSON.parse(body));
            }
        });
    });
}


function refresh_tokens(refreshToken) {
    return new Promise((resolve, reject) => {
        const token_url = 'https://api.honeywell.com/oauth2/token';
        let data = {
            grant_type:'refresh_token', 
            refresh_token: refreshToken,
        }; 
        let headers = {
            'authorization': `Basic ${honeywell_config.credential_base64}`,
        };
        request.post({
            url: token_url,
            headers: headers,
            form: data,
        }, (err, res, body) => {
            if(err) {
                reject(err);
            } else {
                resolve(JSON.parse(body));
            }
        });
    });
}


//let LOCATION_ID = null;

function getLocationId(tokens) {
    //console.log("getLocationId:", tokens);
    // let limit = 5; // the maximum request times due to token refreshing and rate limit of the API providers
    // let n = 0; // keep track of how many requests are made
    return new Promise((resolve, reject) => {
        const location_url = `https://api.honeywell.com/v2/locations?apikey=${honeywell_config.apikey}`;
        // make an API request to get locations
        request.get({
            url: location_url,
            headers: {'authorization': `Bearer ${tokens.access_token}`}
        }, (err, res, body) => { // res: Object, body: Json string
            if(err) {
                reject(err);
            } else {
                try {
                    const locationID = JSON.parse(body)[0].locationID; // Current implementation uses the first available Honeywell location.
                    resolve(locationID.toString());
                } catch(e) {
                    if(res.statusCode === 401) { // access token expires
                        refresh_tokens(tokens.refresh_token).then(data => {
                            //console.log("tokens are refreshed in getLocationID");
                            fs.writeFileSync('tokens.json', JSON.stringify(data));
                            let new_tokens = JSON.parse(fs.readFileSync('tokens.json'));
                            request.get({
                                url: location_url,
                                headers: {'authorization': `Bearer ${new_tokens.access_token}`}
                            }, (err, res, body) => { // res: Object, body: Json string
                                if(err) {
                                    reject(err);
                                } else {
                                    try {
                                        const locationID = JSON.parse(body)[0].locationID; // Current implementation uses the first available Honeywell location.
                                        resolve(locationID.toString());
                                    } catch(e) {
                                        console.log("##An exception is catched", e);
                                        console.log(body);
                                        resolve('1935763'); // manually get this value from honeywell website
                                    }
                                }
                            });
                        });
                    } else if(res.statusCode === 429) {
                        console.error("An exception 429 is catched:", e);
                        console.error(body);
                        reject(e);
                    } else {
                        console.error("An exception is catched:", e);
                        console.error(body);
                        reject(e);
                    }

                }
            }
        });
    });
}

function discoverAllWaterLeakageSensors(location_id, tokens) {
    //console.log("discoverAllWaterLeakageSensors:", tokens);
    return new Promise((resolve, reject) => {
        // if (LOCATION_ID === null) {
        const devices_url = `https://api.honeywell.com/v2/devices?apikey=${honeywell_config.apikey}&locationId=${location_id}`;
        let tokens1 = JSON.parse(fs.readFileSync('tokens.json')); // instead of using tokens, read the token from the database in case tokens are refreshed during getLocationId
        request.get({
            url: devices_url,
            headers: {'authorization': `Bearer ${tokens1.access_token}`}
        }, (err, res, body) => {
            if(err) {
                // Token refresh handling should be implemented for this branch.
            } else {
                try {
                    const devicesRes = JSON.parse(body);
                    let devices = [];
                    devicesRes.forEach(dev => {
                        let device = {};
                        device.label = dev.userDefinedDeviceName;
                        device.uid = dev.deviceID;
                        // device.attributes = ['temperature', 'humidity', 'water'];
                        device.attributes = ['temperature', 'water'];
                        device.values = {};
                        device.values.temperature = dev.currentSensorReadings.temperature;
                        //device.values.humidity = dev.currentSensorReadings.humidity;
                        device.values.water = (dev.waterPresent == true) ? 'wet' : 'dry';
                        device.thingTypeUID = 'cloud:device';
                        device.source = "honeywell";
                        devices.push(device);
                    });
                    resolve(devices);
                } catch(e) {
                    if(res.statusCode === 401) {
                        //console.log("tokens are refreshed in discoverAllWaterLeakageSensors");
                        refresh_tokens(tokens.refresh_token).then(data => {
                            fs.writeFileSync('tokens.json', JSON.stringify(data));
                            let new_tokens = JSON.parse(fs.readFileSync('tokens.json'));
                            request.get({
                                url: devices_url,
                                headers: {'authorization': `Bearer ${new_tokens.access_token}`}
                            }, (err, res, body) => {
                                if(err) { reject(err); }
                                else {
                                    try {
                                        const devicesRes = JSON.parse(body);
                                        let devices = [];
                                        // console.log("devicesRes:", devicesRes)

                                        for(let dev of devicesRes) {
                                            let device = {};
                                            device.label = dev.userDefinedDeviceName;
                                            device.uid = dev.deviceID;
                                            // device.attributes = ['temperature', 'humidity', 'water'];
                                            device.attributes = ['temperature', 'water'];
                                            device.values = {};
                                            device.values.temperature = dev.currentSensorReadings.temperature;
                                            // device.values.humidity = dev.currentSensorReadings.humidity;
                                            device.values.water = (dev.waterPresent == true) ? 'wet' : 'dry';
                                            device.thingTypeUID = 'cloud:device'
                                            device.source = "honeywell";
                                            devices.push(device);
                                        }
                                        resolve(devices); 
                                    } catch(e) {
                                        console.log("###An exception is catched", e);
                                        console.log(JSON.parse(body));
                                    }
                                }
                            });
                        });
                    } else if(res.statusCode === 429) {
                        console.error("An exception is catched:", e);
                        console.error(body);
                        reject(e);      
                    } else {
                        console.error("An exception is catched:", e);
                        console.error(body);
                        reject(e);
                    }
                }
            }
        })
    });
}


// Legacy helper: extend with token refresh if re-enabled.
// function queryWaterLeakageSensorState(id, attribute, tokens) {
//     return new Promise((resolve, reject) => {
//         getLocationId(tokens).then(locationid => {
//             const device_url = `https://api.honeywell.com/v2/devices/waterLeakDetectors/${id}?apikey=${honeywell_config.apikey}&locationId=${locationid}`;
//             request.get({
//                 url: device_url,
//                 headers: {'authorization': `Bearer ${tokens.access_token}`}
//             }, (err, res, body) => {
//                 if(err) {
//                     // Token refresh handling should be implemented for this branch.
//                 } else {
//                     //console.log("body:", body);
//                     try {
//                         const deviceRes = JSON.parse(body);
//                         switch(attribute) {
//                             case 'temperature':
//                                 resolve(deviceRes.currentSensorReadings.temperature);
//                                 break;
//                             case 'humidity':
//                                 resolve(deviceRes.currentSensorReadings.humidity);
//                                 break;
//                             case 'water':
//                                 resolve((deviceRes.waterPresent == true) ? 'wet' : 'dry');
//                                 break;
//                             default:
//                                 console.error("Honeywell water leak detector has no attribute:", attribute);
//                         }
//                     } catch(e) {
//                         if(res.statusCode === 401) {
//                             //console.log("tokens are refreshed");
//                             refresh_tokens(tokens.refresh_token).then(data => {
//                                 fs.writeFileSync('tokens.json', JSON.stringify(data));
//                                 let new_tokens = JSON.parse(fs.readFileSync('tokens.json'));
//                                 request.get({
//                                     url: device_url,
//                                     headers: {'authorization': `Bearer ${new_tokens.access_token}`}
//                                 }, (err, res, body) => {
//                                     if(err) { console.error(err); }
//                                     else {
//                                         try {
//                                             const deviceRes = JSON.parse(body);
//                                             switch(attribute) {
//                                                 case 'temperature':
//                                                     resolve(deviceRes.currentSensorReadings.temperature);
//                                                     break;
//                                                 case 'humidity':
//                                                     resolve(deviceRes.currentSensorReadings.humidity);
//                                                     break;
//                                                 case 'water':
//                                                     resolve((deviceRes.waterPresent == true) ? 'wet' : 'dry');
//                                                     break;
//                                                 default:
//                                                     console.error("Honeywell water leak detector has no attribute:", attribute);
//                                             }
//                                         } catch(e) {
//                                             console.log("####An exception is catched", e);
//                                             console.log(body);
//                                         }
//                                     }
//                                 });
//                             });
//                         } else {
//                             console.error("An exception is catched:", e);
//                             console.error(body);
//                         }
//                     }

//                 }
//             });
//         });
//     });   
// }

let sensors_records = [];
function checkEvents(location_id, tokens, callback) {
    //console.log("lights old:", lights_records);
    discoverAllWaterLeakageSensors(location_id, tokens).then(sensors => {
        //console.log(sensors);
        if(sensors_records.length !== 0) {
            sensors.forEach(new_state => {
                sensors_records.forEach(old_state => {
                    //console.log(new_state, old_state);
                    if(new_state.id === old_state.id) {
                        //console.log("here");
                        for(let attr of new_state.attributes) {
                            //console.log(attr);
                            if(new_state.values[attr] !== old_state.values[attr]) {
                                //console.log(`New event: ${new_state.id}, ${attr}, ${new_state.values[attr]}`);
                                let event = {};
                                event.device = {};
                                //console.log("new_state honeywell:", new_state)
                                [event.device.uid, event.device.label, event.device.attributes, event.attribute, event.value] = [new_state.uid, new_state.label, new_state.attributes, attr, new_state.values[attr]];
                                callback(event);
                            }
                        }
                    }
                });
            });
        }
        //console.log("update...");
        sensors_records = sensors;
    }).catch(err => {
        console.error(err);
    });
}


function subscribeToEvents(location_id, tokens, callback, interval=300000) {
	setInterval(checkEvents, interval, location_id, tokens, callback);
}



module.exports = {
    request_authorize: request_authorize,
    request_tokens: request_tokens, 
    refresh_tokens: refresh_tokens,
    discoverAllWaterLeakageSensors: discoverAllWaterLeakageSensors,
    // queryWaterLeakageSensorState: queryWaterLeakageSensorState,
    getLocationId: getLocationId,
    subscribeToEvents: subscribeToEvents,
}


// if (typeof require !== 'undefined' && require.main === module) {
//     request_authorize();
//     request_tokens(code).then(tokens => {
//         console.log(token);
//     });
// }