const lifx = require('lifx-http-api');
const db = require('../core/db');
const { subscribeToAllItemStateChanged } = require('./device-connector');
const lifx_config = require('../../config/default').cloud_device_connector.lifx;

db.open();

const vendor = 'lifx';
let client = new lifx({
    bearerToken: lifx_config.bearerToken // the token is obtained directly from https://cloud.lifx.com/settings
});

let token = {};
token.client_id = "";
token.platform = vendor;
token.keyword = "";
token.access_token = lifx_config.bearerToken;
token.refresh_token = "";
token.expires_in = "";
token.token_url = "";
token.callback_url = "";
db.updatePToken(token);




// initialize the local records
let lights_records = [];


function request_authorize() {
    console.log('========================================================================================================================')
    console.log('Please visit this link to get token for IoTMediator to access your LIFX devices:\n', "https://cloud.lifx.com/settings");
    console.log('After that, update the bearerToken in configuration');
    console.log('========================================================================================================================')
}


function discoverAllLights() {
    return new Promise((resolve, reject) => {
        client.listLights('all').then(allLights => {
            let lights = [];
            allLights.forEach(light => {
                let lightdev = {};
                lightdev.label = light.label;
                lightdev.uid = light.id;
                lightdev.attributes = ['switch'];
                lightdev.values = {};
                lightdev.values.switch = light.power;
                lightdev.thingTypeUID = 'cloud:device';
                lightdev.source = 'lifx';
                lights.push(lightdev);
            });
            resolve(lights);
        }, err => {
            reject(err);
        })
    });

}


function queryLightSwitchState(id) {
    return new Promise((resolve, reject) => {
        client.listLights('id:'+id).then(results => {
            //console.log("query:", results);
            resolve({uid:results[0].uid, attribute:'switch', value:results[0].power}); // id is unique, so only one light is returned in results.
        }, err => {
            console.error(err);
        })
    });    
}


function controlLight(id, command) {
    return new Promise((resolve, reject) => {
        client.setState('id:'+id, {
            power: command
        }).then(data => {
            if(data[0].status === 'ok') {
                resolve(true);
            } else {
                console.error("Error when setting LIFX light:"+id);
            }
        }, err => {
            console.error(err);
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
                                //console.log("new_state lifx:", new_state)
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
    }).catch(err => {
        console.error(err);
    });
}


function subscribeToEvents(callback, interval=1000) {
	setInterval(checkEvents, interval, callback);
}


module.exports = {
    request_authorize: request_authorize,
    discoverAllLights: discoverAllLights,
    queryLightSwitchState: queryLightSwitchState,
    controlLight: controlLight,
    subscribeToEvents: subscribeToEvents,
};


if (typeof require !== 'undefined' && require.main === module) {
    // discoverAllLights().then(lights => {
	// 	console.log("Discover:", lights);
    // });
    
    // queryLightSwitchState('d073d55704b3').then(data => {
    //     console.log("Query:", data);
    // });
    // controlLight('d073d55704b3', 'off');
    subscribeToEvents((event) => {});
}