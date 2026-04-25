'use strict';

//const v3 = require('node-hue-api').v3;
const v3 = require('node-hue-api').v3;
const randtoken = require('rand-token');
const utility = require('../core/utility.js');
const fs = require('fs');
const hue_config = require('../../config/default').cloud_device_connector.hue;
const db = require('../core/db');


//let credentials = JSON.parse(fs.readFileSync('credentials.json'));

// fixed values with IoTMediator
// const CLIENT_ID = credentials.clientId
// 	, CLIENT_SECRET = credentials.clientSecret;

// const ACCESS_TOKEN = credentials.tokens.access.value
//   , REFRESH_TOKEN = credentials.tokens.refresh.value
//   , USERNAME = credentials.username;

const CLIENT_ID = hue_config.clientId;
const CLIENT_SECRET = hue_config.clientSecret;
const APP_ID = hue_config.appId;


const remoteBootstrap = v3.api.createRemote(CLIENT_ID, CLIENT_SECRET);

// initialize the records
let lights_records = [];
let sensors_records = [];


function request_authorize(authorizationCode=null) {
    const STATE = randtoken.generate(26).toString();
    //console.log("STATE:", STATE);
    // Replace this with your authorization code that you get from the Callback URL for your Hue Remote API Application.
    // If you do not fill this value in, the code will give you the URL to start the process for generating this value.
    console.log('========================================================================================================================')
    console.log('Please visit this link to authorize IoTMediator to access your Hue devices:\n', `${remoteBootstrap.getAuthCodeUrl('node-hue-api-remote', APP_ID, STATE)}`);
    console.log('========================================================================================================================')
}

function request_tokens(code) {
    return new Promise((resolve, reject) => {
        const remoteBootstrap = v3.api.createRemote(CLIENT_ID, CLIENT_SECRET);
        remoteBootstrap.connectWithCode(code)
        .catch(err => {
            console.error('Failed to get a remote connection using authorization code.');
            console.error(err);
            process.exit(1);
        })
        .then(api => {
            console.log('Successfully validated authorization code and exchanged for tokens');
            const remoteCredentials = api.remote.getRemoteAccessCredentials();
            // console.log(remoteCredentials);
            // console.log(`Remote API Access Credentials:\n ${JSON.stringify(remoteCredentials, null, 2)}\n`);
            // console.log(`The Access Token is valid until:  ${new Date(remoteCredentials.tokens.access.expiresAt)}`);
            // console.log(`The Refresh Token is valid until: ${new Date(remoteCredentials.tokens.refresh.expiresAt)}`);
            // console.log('\nNote: You should securely store the tokens and username from above as you can use them to connect\n'
            // + 'in the future.');
    
            resolve(remoteCredentials);
            // Do something on the remote API, like list the lights
            // return api.lights.getAll()
            // .then(lights => {
            //     console.log('Retrieved the following lights for the bridge over the Remote Hue API');
            //     lights.forEach(light => {
            //     console.log(light.toStringDetailed());
            //     })
            // });
        });
    })

}


function discoverAllLights() {
    return new Promise((resolve, reject) => {
        db.getPToken('hue').then((tokens) => {
            if (tokens === undefined) {
                console.error("Please authorize IoTMediator to access your Hue lights first and then launch IoTMediator again");
                return;
            }
            remoteBootstrap.connectWithTokens(tokens.access_token, tokens.refresh_token, tokens.keyword)
            .catch(err => {
                console.error('Failed to get a remote connection using existing tokens. Refresh tokens...');
                v3.api.remote.refreshTokens().then(new_tokens => {
                    console.log(JSON.stringify(new_tokens, null, 2));
                    token = {};
                    token.client_id = tokens.clientId;
                    token.client_secret = tokens.clientSecret;
                    token.platform = tokens;
                    token.keyword = tokens.username;
                    token.access_token = new_tokens.accessToken;
                    token.refresh_token = new_tokens.refreshToken;
                    token.expires_in = data.tokens.access.expiresAt; // this one is useless
                    token.token_url = "";
                    token.callback_url = "";
                    db.updatePToken(token).then(() => {
                        db.getPToken('hue').then((updated_tokens) => {
                            remoteBootstrap.connectWithTokens(updated_tokens.access_token, updated_tokens.refresh_token, updated_tokens.keyword)
                            .then(api => {
                                api.lights.getAll().then(allLights => {
                                    let lights = [];
                                    allLights.forEach(light => { // only consider lights have a capability "switch" 
                                        let lightdev = {};
                                        lightdev.label = light._data.name;
                                        lightdev.uid = light._data.type + light._data.id;
                                        lightdev.uid = lightdev.uid.replace(/\s/g, ""); // remove whitespaces in uid
                                        lightdev.attributes = ['switch'];
                                        lightdev.values = {};
                                        lightdev.values.switch = light._data.state.on ? "on" : "off";
                                        lightdev.thingTypeUID = 'cloud:device';
                                        lightdev.source = "hue";
                                        lights.push(lightdev);
                                    });
                                    resolve(lights);
                                });
                            });
                        });
                    });
                }).catch(err => {reject("#error when refreshing hue API token", err)});
            }).then(api => {        
                api.lights.getAll().then(allLights => {
                    //console.log(JSON.stringify(allLights, null, 2));
                    let lights = [];
                    allLights.forEach(light => { // only consider lights have a capability "switch" 
                        let lightdev = {};
                        lightdev.label = light._data.name;
                        lightdev.uid = light._data.type + light._data.id;
                        lightdev.uid = lightdev.uid.replace(/\s/g, ""); // remove whitespaces in uid
                        lightdev.attributes = ['switch'];
                        lightdev.values = {};
                        lightdev.values.switch = light._data.state.on ? "on" : "off";
                        lightdev.thingTypeUID = 'cloud:device';
                        lightdev.source = "hue";
                        lights.push(lightdev);
                    });
                    //console.log(lights);
                    //lights_old = lights;
                    //console.log(lights);
                    resolve(lights);
                });
            }).catch(err => {reject("##error when finding all Hue lights", err)});
        });
    });
}


function discoverAllSensors() {
    return new Promise((resolve, reject) => {
        db.getPToken('hue').then((tokens) => {
            if (tokens === undefined) {
                console.error("Please authorize IoTMediator to access your Hue sensors first and then launch IoTMediator again");
                return;
            }
            remoteBootstrap.connectWithTokens(tokens.access_token, tokens.refresh_token, tokens.keyword)
            .catch(err => {
                console.error('Failed to get a remote connection using existing tokens.');
                v3.api.remote.refreshTokens().then(new_tokens => {
                    console.log(JSON.stringify(new_tokens, null, 2));
                    token = {};
                    token.client_id = tokens.clientId;
                    token.client_secret = tokens.clientSecret;
                    token.platform = tokens;
                    token.keyword = tokens.username;
                    token.access_token = new_tokens.accessToken;
                    token.refresh_token = new_tokens.refreshToken;
                    token.expires_in = data.tokens.access.expiresAt; // this one is useless
                    token.token_url = "";
                    token.callback_url = "";
                    db.updatePToken(token).then(() => {
                        db.getPToken('hue').then((updated_tokens) => {
                            remoteBootstrap.connectWithTokens(updated_tokens.access_token, updated_tokens.refresh_token, updated_tokens.keyword)
                            .then(api => {
                                api.sensors.getAll().then(allSensors => {
                                    // console.log(JSON.stringify(allLights, null, 2));
                                    let sensors = [];
                                    allSensors.forEach(sensor => {
                                        if(sensor._data.type === 'ZLLPresence') {
                                            //console.log(sensor._data.state.presence);
                                            let sensordev = {};
                                            sensordev.label = sensor._data.name;
                                            sensordev.uid = sensor._data.type + sensor._data.id;
                                            sensordev.uid = sensordev.uid.replace(/\s/g, ""); // remove whitespaces in uid
                                            sensordev.attributes = ["motion"];
                                            sensordev.values = {};
                                            sensordev.values.motion = sensor._data.state.presence? "active" : "inactive";
                                            sensordev.thingTypeUID = 'cloud:device';
                                            sensordev.source = 'hue';
                                            sensors.push(sensordev);
                                        };
                                    });
                                    resolve(sensors);
                                });
                            });
                        });
                    });
                })
            }).then(api => {        
                api.sensors.getAll().then(allSensors => {
                    // console.log(JSON.stringify(allLights, null, 2));
                    let sensors = [];
                    allSensors.forEach(sensor => {
                        if(sensor._data.type === 'ZLLPresence') {
                            //console.log(sensor._data.state.presence);
                            let sensordev = {};
                            sensordev.label = sensor._data.name;
                            sensordev.uid = sensor._data.type + sensor._data.id;
                            sensordev.uid = sensordev.uid.replace(/\s/g, ""); // remove whitespaces in uid
                            sensordev.attributes = ["motion"];
                            sensordev.values = {};
                            sensordev.values.motion = sensor._data.state.presence? "active" : "inactive";
                            sensordev.thingTypeUID = 'cloud:device';
                            sensordev.source = 'hue';
                            sensors.push(sensordev);
                        };
                    });
                    //console.log(sensors);
                    //sensors_old = sensors;
                    resolve(sensors);
                });
            });
        });
    });
}



function controlLight(id, command) {
    return new Promise((resolve, reject) => {
        db.getPToken('hue').then((tokens) => {
            if (tokens === undefined) {
                reject("Please authorize first and then launch IoTMediator again");
            }
            remoteBootstrap.connectWithTokens(tokens.access_token, tokens.refresh_token, tokens.keyword)
            .catch(err => {
              console.error('Failed to get a remote connection using existing tokens.');
              v3.api.remote.refreshTokens().then(new_tokens => {
                        console.log(JSON.stringify(new_tokens, null, 2));
                        token = {};
                        token.client_id = tokens.clientId;
                        token.client_secret = tokens.clientSecret;
                        token.platform = tokens;
                        token.keyword = tokens.username;
                        token.access_token = new_tokens.accessToken;
                        token.refresh_token = new_tokens.refreshToken;
                        token.expires_in = data.tokens.access.expiresAt; // this one is useless
                        token.token_url = "";
                        token.callback_url = "";
                        db.updatePToken(token).then(() => {
                            db.getPToken('hue').then((updated_tokens) => {
                                remoteBootstrap.connectWithTokens(updated_tokens.access_token, updated_tokens.refresh_token, updated_tokens.keyword)
                                .then(api => {
                                    let state;
                                    if(command === "on") {
                                        state = new v3.lightStates.LightState().on();
                                    } else {
                                        state = new v3.lightStates.LightState().off();
                                    }
                            
                                    return api.lights.setLightState(utility.getHueId(id), state).then(() => {
                                        resolve();
                                    });
                                })
                            });
                        });
                })
            }).then(api => {        
                let state;
                if(command === "on") {
                    state = new v3.lightStates.LightState().on();
                } else {
                    state = new v3.lightStates.LightState().off();
                }
                api.lights.setLightState(utility.getHueId(id), state).then(() => {
                    resolve();
                });
            })
        });
    })

}



function checkEvents(callback) {
    //console.log("lights old:", lights_records);
    discoverAllLights().then(lights => {
        //console.log("lights new:", lights);
        if(lights_records.length !== 0) {
            lights.forEach(new_state => {
                lights_records.forEach(old_state => {
                    //console.log(new_state, old_state);
                    if(new_state.uid === old_state.uid) {
                        //console.log("here");
                        for(let attr of new_state.attributes) {
                            //console.log(attr);
                            if(new_state.values[attr] !== old_state.values[attr]) {
                                //console.log(`New event: ${new_state.id}, ${attr}, ${new_state.values[attr]}`);
                                let event = {};
                                event.device = {};
                                //console.log("new_state hue:", new_state)
                                [event.device.uid, event.device.label, event.device.attributes, event.attribute, event.value] = [new_state.uid, new_state.label, new_state.attributes, attr, new_state.values[attr]];
                                callback(event);
                            }
                        }
                    }
                });
            });
        }
        //console.log("update...");
        lights_records = lights;
    });

    discoverAllSensors().then(sensors => {
        //console.log("lights new:", lights);
        if(sensors_records.length !== 0) {
            sensors.forEach(new_state => {
                sensors_records.forEach(old_state => {
                    //console.log(new_state, old_state);
                    if(new_state.uid === old_state.uid) {
                        //console.log("here");
                        for(let attr of new_state.attributes) {
                            //console.log(attr);
                            if(new_state.values[attr] !== old_state.values[attr]) {
                                let event = {};
                                event.device = {};
                                [event.device.uid, event.device.label, event.device.attributes, event.attribute, event.value] = [new_state.uid, new_state.label, new_state.attributes, attr, new_state.values[attr]];
                                //console.log(event);
                                callback(event);
                            }
                        }
                    }
                });
            });
        }
        //console.log("update...");
        sensors_records = sensors;
    });
}


function subscribeToEvents(callback, interval=3000) {
	setInterval(checkEvents, interval, callback);
}





module.exports = {
    request_authorize: request_authorize,
    request_tokens: request_tokens,
	discoverAllLights: discoverAllLights,
	discoverAllSensors: discoverAllSensors,
	controlLight: controlLight,
    subscribeToEvents: subscribeToEvents,
}


if (typeof require !== 'undefined' && require.main === module) {
    subscribeToEvents();
    db.open();
    request_authorize();
    discoverAllLights().then(lights => {
        console.log(lights);
    });

    discoverAllSensors().then(sensors => {
        console.log(sensors);
    });

    //controlLight('Dimmable light1', "on");
}