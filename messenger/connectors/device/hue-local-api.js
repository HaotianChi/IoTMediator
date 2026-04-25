const v3 = require('node-hue-api').v3;
const discovery = v3.discovery; 
hueApi = v3.api;
const LightState = v3.lightStates.LightState;
const utility = require('../core/utility.js');
const appName = 'pfirewall-chenglong';
const deviceName = 'pfirewall-hue';
const hue_config = require('../../config/default').cloud_device_connector.hue
const config = require('../../config/default');


// initialize the records
let lights_records = [];
let sensors_records = [];


function discoverBridge() {
    return new Promise((resolve, reject) => {
        discovery.nupnpSearch().then(discoveryResults => {
            if (discoveryResults.length === 0) {
                console.error('Failed to resolve any Hue Bridges');
                resolve(null);
            } else {
                // Ignoring that you could have more than one Hue Bridge on a network as this is unlikely in 99.9% of users situations
                //console.log(discoveryResults);
                resolve(discoveryResults[0].ipaddress);
            }
        });
    })
}



function discoverAndCreateUser() {
    return new Promise(async (resolve, reject) => {
        discoverBridge().then(ipAddress => {
            console.log(ipAddress);
            // Create an unauthenticated instance of the Hue API so that we can create a new user
            hueApi.createLocal(ipAddress).connect().then(unauthenticatedApi => {
                let createdUser;
                console.log("here111");
                unauthenticatedApi.users.createUser(appName, deviceName).then(createdUser => {
                    console.log("here222");
                    resolve(createdUser);
                })
            }).catch(err => {
                if (err.getHueErrorType() === 101) {
                    console.error('The Link button on the bridge was not pressed. Please press the Link button and try again.');
                    setTimeout(() => {
                        try {
                            unauthenticatedApi.users.createUser(appName, deviceName).then(createdUser => {
                                // Create a new API instance that is authenticated with the new user we created
                                hueApi.createLocal(ipAddress).connect(createdUser.username).then(authenticatedApi => {
                                    // Do something with the authenticated user/api
                                    authenticatedApi.configuration.getConfiguration().then(bridgeConfig => {
                                        console.log(`Connected to Hue Bridge: ${bridgeConfig.name} :: ${bridgeConfig.ipaddress}`);
                                        resolve(createdUser);
                                    })
                                })
                            })
                        } catch(err) {
                            console.error(`Still Error, press the Link buttion and try to launch IoTMediator again`);
                        }
                    }, 15000)
                } else {
                    console.error(`Unexpected Error: ${err.message}`);
                }
            })
        });
    });
}



// const USERNAME = 'l16wnxI45Hfxtc1-6VXDDRIoksRSea6NX1SAii-7';
const USERNAME = hue_config.local_username;


function createHueApi() {
    return new Promise(async (resolve, reject) => {
        v3.discovery.nupnpSearch().then(async searchResults => {
            const bridgeHost = searchResults[0].ipaddress;
            //console.log("host:", bridgeHost);
            resolve(v3.api.createLocal(bridgeHost).connect(USERNAME));
        });
    })
}

function discoverAllLights(api) {
    return new Promise((resolve, reject) => {
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
    })

}


function discoverAllSensors(api) {
    return new Promise((resolve, reject) => {
        api.sensors.getAll().then(allSensors => {
            // console.log(JSON.stringify(allLights, null, 2));
            let sensors = [];
            let motion_sensor_components = [];
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
                    motion_sensor_components.push(sensordev);
                } else if(sensor._data.type === 'ZLLLightLevel') {
                    let sensordev = {};
                    // sensordev.label = sensor._data.name;
                    // sensordev.label = sensordev.label.replace(/\s/g, ""); // remove whitespaces in label
                    // sensordev.label = sensordev.label + "_" + config.target_platform;
                    // sensordev.uid = sensor._data.type + sensor._data.id;
                    // sensordev.uid = sensordev.uid.replace(/\s/g, ""); // remove whitespaces in uid
                    sensordev.attributes = ["illuminance"];
                    sensordev.values = {};
                    sensordev.values.illuminance = parseFloat(Math.pow(10, (sensor._data.state.lightlevel-1)/10000).toFixed(2));
                    // sensordev.thingTypeUID = 'cloud:device';
                    // sensordev.source = 'hue';
                    motion_sensor_components.push(sensordev);
                } else if(sensor._data.type === 'ZLLSwitch') {
                    let sensordev = {};
                    sensordev.label = sensor._data.name;
                    sensordev.uid = sensor._data.type + sensor._data.id;
                    sensordev.uid = sensordev.uid.replace(/\s/g, ""); // remove whitespaces in uid
                    sensordev.attributes = ["button_group"];
                    sensordev.values = {};
                    const value = sensor._data.state.buttonevent;
                    sensordev.values.button_group = parseInt(value/1000);
                    sensordev.thingTypeUID = 'cloud:device';
                    sensordev.source = 'hue';
                    sensors.push(sensordev);
                } else if(sensor._data.type === 'ZLLTemperature') {
                    let sensordev = {};
                    // sensordev.label = sensor._data.name;
                    // sensordev.label = sensordev.label.replace(/\s/g, ""); // remove whitespaces in label
                    // sensordev.label = sensordev.label + "_" + config.target_platform;
                    // sensordev.uid = sensor._data.type + sensor._data.id;
                    // sensordev.uid = sensordev.uid.replace(/\s/g, ""); // remove whitespaces in uid
                    sensordev.attributes = ["temperature"];
                    sensordev.values = {};
                    sensordev.values.temperature = sensor._data.state.temperature / 100;
                    // sensordev.thingTypeUID = 'cloud:device';
                    // sensordev.source = 'hue';
                    motion_sensor_components.push(sensordev);
                }
            });
            // combine motion, temperature and illuminance components to multi-purpose motion sensors
            for(let i=0; i < motion_sensor_components.length; i=i+3) {
                let motion_sensor = motion_sensor_components[i]
                // console.log(i, motion_sensor)
                motion_sensor.attributes.push(motion_sensor_components[i+1].attributes[0])
                motion_sensor.values[motion_sensor_components[i+1].attributes[0]] = motion_sensor_components[i+1].values[motion_sensor_components[i+1].attributes[0]];

                motion_sensor.attributes.push(motion_sensor_components[i+2].attributes[0])
                motion_sensor.values[motion_sensor_components[i+2].attributes[0]] = motion_sensor_components[i+2].values[motion_sensor_components[i+2].attributes[0]];

                sensors.push(motion_sensor)
            }
            resolve(sensors);
        });
    });
}


function controlLight(api, id, command) {
    return new Promise((resolve, reject) => {  
        let state;
        if(command === "on") {
            state = new LightState().on();
        } else {
            state = new LightState().off();
        }
        api.lights.setLightState(utility.getHueId(id), state).then(() => {
            resolve();
        });
    });
}

function checkEvents(api, callback) {
    //console.log("lights old:", lights_records);
    discoverAllLights(api).then(lights => {
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

    discoverAllSensors(api).then(sensors => {
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


function subscribeToEvents(api, callback, interval=1000) {
	setInterval(checkEvents, interval, api, callback);
}


module.exports = {
    discoverAndCreateUser: discoverAndCreateUser,
    createHueApi: createHueApi,
	discoverAllLights: discoverAllLights,
	discoverAllSensors: discoverAllSensors,
	controlLight: controlLight,
    subscribeToEvents: subscribeToEvents,
}


if (typeof require !== 'undefined' && require.main === module) {
    // discoverAndCreateUser().then(user => {console.log(user)}); // only run once for easy implementation; copy the username to config/default;
    createHueApi().then(api => {
        // discoverAllLights(api).then(lights => {
        //     console.log("lights:", lights);
        //     controlLight(api, lights[1].uid, 'off');
        // });
        discoverAllSensors(api).then(sensors => {
            console.log("sensors:", sensors)
        });
    
        // subscribeToEvents(api, (event) => {
        //     console.log(event);
        // })

        // api.sensors.getAll().then(sensors => {
        //     // console.log(sensors[1]._data)         
        //     for (let s of sensors) {
        //         // console.log(s._data.id, s._data.type, s._data.name)
        //         console.log(s._data)
        //     }
        // })
    })

}