var express = require('express');
var router = express.Router();
const {SchemaConnector, DeviceErrorTypes, StateUpdateRequest, DiscoveryRequest, DiscoveryDevice} = require('st-schema');
var db = require('../core/db.js');
const config = require('../../config/default');
const hooks = require('../hooks');
// const router_oauth2_ST = require('./routes/smartthings/oauth2.js');

const deviceConnector= require('../connectors/device/device-connector');
const cloudDeviceConnector = require('../connectors/device/cloud-device-connector');
var api = require('./smartthings-api');

const platform = 'smartthings'
db.open();

/*
    Define the smartthings cloud schema connector
*/
var connector_ST;
var accessTokens_ST = {}; // the data structure is for convenient use of st-schema APIs
var client_id_ST;
db.getPToken(platform).then((ptoken) => {
    if(ptoken) {
      client_id_ST = ptoken.client_id;
      const callbackAuthentication = {tokenType: "Bearer", accessToken: ptoken.access_token, refreshToken: ptoken.refresh_token, expiresIn: ptoken.expires_in};
      const callbackUrls = {oauthToken: ptoken.token_url, stateCallback: ptoken.callback_url};
      accessTokens_ST[ptoken.keyword] = {callbackAuthentication, callbackUrls};
    }
    connector_ST = new SchemaConnector()
    .clientId(config.smartthings.client_id)
    .clientSecret(config.smartthings.client_secret)
    .discoveryHandler(async (accessToken, response) => {
      await db.getDevices().then((devices) => {
        var dev;
        for (dev of devices) {
          var device = response.addDevice(dev.device_id, dev.label.split('_')[0], api.findDeviceHandlerTypeFromAttributes(dev.attributes)); // suffix of device labels are removed before sent to platform
          // add manufacturerInfo properties to the device
          device.manufacturerName('default');
          device.modelName('default');
          device.hwVersion('default');
          device.swVersion('default');
        }
        //console.log("device discovery response: ", response);
      })
      return response;
    })
    .stateRefreshHandler(async (accessToken, response, body) => {
      //console.log("stateRefreshHandler: ", body.devices);
      var requestedDevice;
      await db.getStates().then((all_states) => {
        if(all_states) {
          for (requestedDevice of body.devices) {
            //console.log("requestedDevice:", body.devices);
            var states = [];
            for(each_state of all_states) {
              if(each_state.device_id === requestedDevice.externalDeviceId) {
                states.push(each_state);
              }
            }
				//console.log("###############", states);
        // add an entry to the state refresh response for a requested device based on its state info.
        
				response.addDevice(requestedDevice.externalDeviceId, formatDBStates4ST(states));
            }
        } 
      });
      return response;
    })

    .commandHandler(async (accessToken, response, devices) => {
      const requestedDevice = devices[0];
      try {
        const localdevice = await db.getDevice(requestedDevice.externalDeviceId);
        if(!localdevice) {
          response.addDevice(requestedDevice.externalDeviceId);
          return response;
        }
        let promises = [];
        if(localdevice.thingTypeUID === "cloud:device") {
          for(let cmd of requestedDevice.commands) {
            const cloudCommand = api.command2CloudCommand(cmd);
            //console.log("command:", cloudCommand);
            if(cloudCommand.method) {
              const commandContext = {
                platform: platform,
                device: {uid: requestedDevice.externalDeviceId, label: localdevice.label},
                attribute: cloudCommand.category,
                value: cloudCommand.method,
                is_cloud_device: true,
                raw: {command: cmd, device: requestedDevice},
              };
              promises.push(db.insertCommand({
                device: {uid: requestedDevice.externalDeviceId, label: localdevice.label},
                attribute: cloudCommand.category,
                value: cloudCommand.method,
                platform: platform,
              }));
              promises.push(hooks.handlePlatformCommand(commandContext, () => {
                return cloudDeviceConnector.sendCommandToDevice(requestedDevice.externalDeviceId, cloudCommand.method);
              }));
            }
          }

        } else { // zigbee, zwave
          const localdevice1 = await deviceConnector.getDevice(requestedDevice.externalDeviceId);
          for(let cmd of requestedDevice.commands) {
            const itemCommand = api.command2ItemCommand(cmd);
            if(itemCommand.method) {
              const commandContext = {
                platform: platform,
                device: {uid: requestedDevice.externalDeviceId, label: localdevice.label},
                attribute: itemCommand.category,
                value: itemCommand.method,
                is_cloud_device: false,
                raw: {command: cmd, device: requestedDevice},
              };
              promises.push(db.insertCommand({
                device: {uid: requestedDevice.externalDeviceId, label: localdevice.label},
                attribute: itemCommand.category,
                value: itemCommand.method,
                platform: platform,
              }));
              promises.push(hooks.handlePlatformCommand(commandContext, () => {
                let sendPromises = [];
                if(localdevice1) {
                  for(let item of localdevice1.items) {
                    if(item.category === itemCommand.category) {
                      sendPromises.push(deviceConnector.sendCommandToItem(item, itemCommand.method));
                    }
                  }
                }
                return Promise.allSettled(sendPromises);
              }));
            }
          }
        }

        await Promise.allSettled(promises);
        response.addDevice(requestedDevice.externalDeviceId);
        return response;
      } catch (err) {
        console.error("command Handler error:", err);
        response.addDevice(requestedDevice.externalDeviceId);
        return response;
      }
      


        // var localdevice = await deviceConnector.getDevice(requestedDevice.externalDeviceId).then( async(localdevice) => {
        //     return localdevice;
		// });

		// if(localdevice === undefined) {
		// 	localdevice = await cloudDeviceConnector.getDevice(requestedDevice.externalDeviceId).then(async(localdevice) => {
		// 		return localdevice;
		// 	}) 
		// }
		// if(localdevice === undefined) {
		// 	console.error(`cannot find device with uid: ${requestedDevice.externalDeviceId}`);
		// 	return;
		// }
        // console.log("localdevice: ", localdevice);


    //     await Promise.all(promises).then(() => {
    //         // await db.getDeviceStates(localdevice.uid).then(states => {
    //         //     response.addDevice(requestedDevice.externalDeviceId, formatDBStates4ST(states));
    //         //     console.log("inner: ", response);
                
    //         // })
    //         var states = [];
    //         var item;
    //         for(item of localdevice.items) {
    //             var state = {};
    //             state.device_id = localdevice.uid;
    //             state.attribute = item.category;
    //             state.value = item.state;
    //             states.push(state);
    //         }
    //         response.addDevice(requestedDevice.externalDeviceId, formatDBStates4ST(states));
    //         return response;
    //     });

    })
    .callbackAccessHandler(async (accessToken, clientId, callbackAuthentication, callbackUrls) => { // clientId: the clientId generated by ST 
      accessTokens_ST[accessToken] = { //accessToken: Token used by smartthings for authentication to us
        callbackAuthentication, // callbackAuthentication: (tokenType, accessToken, refreshToken, expiresIn)
        callbackUrls // oauthToken Url, stateCallback url
      }
      client_id_ST = clientId;
      token = {};
      token.client_id = clientId;
      token.platform = platform;
      token.keyword = accessToken;
      token.access_token = callbackAuthentication.accessToken;
      token.refresh_token = callbackAuthentication.refreshToken;
      token.expires_in = callbackAuthentication.expiresIn;
      token.token_url = callbackUrls.oauthToken;
      token.callback_url = callbackUrls.stateCallback;
      db.updatePToken(token);
    //   db.updatePToken(token).then(() => {
	// 		// Listen to device events in order to update the database
	// 		deviceConnector.subscribeToAllItemStateChanged((event) => {
	// 			db.insertEvent(event);
	// 			db.updateState(event);
	// 			db.getEventTargetPlatform(event).then(target_platform => {
	// 				pushEventToTargetPlatform(event, target_platform);
	// 			})
	// 		});

	// 		deviceConnector.subscribeToThingAdded((device) => {
	// 			// refresh the Devices table
	// 			db.initializeDevices(deviceConnector).then(devices => {
	// 				db.initializeStates(devices).then(states => {
	// 					db.getDeviceTargetPlatform(device).then(target_platform => {
	// 						pushDeviceToTargetPlatform(device, target_platform)
	// 					})
	// 				});
	// 			});
	// 		})

	// 		cloudDeviceConnector.subscribeToEvents((event) => {  
	// 			db.insertCloudDeviceEvent(event);
	// 			db.updateCloudDeviceState(event);
	// 			db.getEventTargetPlatform(event).then(target_platform => {
	// 				console.log(`New event: ${event.device.label, event.attribute, event.value}`);
	// 				console.log(`New event: ${event.device.label, event.attribute, event.value}, target platform: ${target_platform}`);
	// 				pushEventToTargetPlatform(event, target_platform);
	// 			});
	// 		});
    //   }).catch(err => {console.error(err);});
    })
    .integrationDeletedHandler(accessToken => {
      delete accessTokens_ST[accessToken]
    });
    connector_ST.enableEventLogging(2, config.verbose); // the second argument default value true, enabling the logging of requests and responses
});


// /integration is requested by SmartThings automatically
router.post('/integration', (req, res) => {
  if (validateSTTokens(req)) {   
    connector_ST.handleHttpCallback(req, res)
  }
});

// /api is requested by IoTMediator internal APIs
router.post('/api/stateupdate', (req, res) => {
  if (!req.body.deviceState) {
    return res.send('Device state is not given!');
  }
  const deviceState = req.body.deviceState;
  //console.log("================", deviceState);
  var accessToken;
  for (accessToken in accessTokens_ST) {
    //console.log(accessToken);
    const stateUpdateRequest = new StateUpdateRequest(config.smartthings.client_id, config.smartthings.client_secret);
    stateUpdateRequest.updateState(accessTokens_ST[accessToken].callbackUrls, accessTokens_ST[accessToken].callbackAuthentication, deviceState, async (refreshCallbackAuthentication) => {
       //console.log("here2");  
       accessTokens_ST[accessToken].callbackAuthentication = refreshCallbackAuthentication;
       //db.updateTokens(accessTokens_ST);
       token = {};
       token.client_id = client_id_ST;
       token.platform = platform;
       token.keyword = accessToken;
       token.access_token = refreshCallbackAuthentication.accessToken;
       token.refresh_token = refreshCallbackAuthentication.refreshToken;
       token.expires_in = refreshCallbackAuthentication.expiresIn;
       token.token_url = accessTokens_ST[accessToken].callbackUrls.oauthToken;
       token.callback_url = accessTokens_ST[accessToken].callbackUrls.stateCallback;
       db.updatePToken(token).catch(err => {console.error(err);});
    }).then(res => {
      res = JSON.stringify(res);
      //console.log("res:", res);
      return res;
    }) // expecting a json response
    .then(json => {
      // console.log(json)
    }, err => {
      console.log(err)
    }).finally(() => {});
  }
  res.send("successful!");
});

router.post('/api/discoveryupdate', (req, res) => { 
  if (!req.body.devices) {
    return res.send('Devices are not given!');
  }
  const devices = req.body.devices;
  var accessToken;
  
  for (accessToken in accessTokens_ST) {
    const discoveryRequest = new DiscoveryRequest(config.smartthings.client_id, config.smartthings.client_secret);
    var idx;
    for (idx in devices) {
      discoveryRequest.addDevice(devices[idx]);
    }
    var result = discoveryRequest.sendDiscovery(accessTokens_ST[accessToken].callbackUrls, accessTokens_ST[accessToken].callbackAuthentication, (refreshCallbackAuthentication) => {
      // the function is used to update tokens upon refresh response, which is obtained if the access token expires
      //console.log("here1");
      accessTokens_ST[accessToken].callbackAuthentication = refreshCallbackAuthentication;
      //db.updateTokens(accessTokens_ST);
      token = {};
      token.client_id = client_id_ST;
      token.platform = platform;
      token.keyword = accessToken;
      token.access_token = refreshCallbackAuthentication.accessToken;
      token.refresh_token = refreshCallbackAuthentication.refreshToken;
      token.expires_in = refreshCallbackAuthentication.expiresIn;
      token.token_url = accessTokens_ST[accessToken].callbackUrls.oauthToken;
      token.callback_url = accessTokens_ST[accessToken].callbackUrls.stateCallback;
      db.updatePToken(token).catch(err => {console.error(err);});
    }).then(res => {
      res = JSON.stringify(res);
      //console.log("res:", res);
      return res;
    }).catch(err => {console.log("err:", err);})
  }  
  res.send("successful!");
});
 
   
function validateSTTokens(req) {
  return true;
}

// format the states for assembling state refresh response
function formatDBStates4ST(device_states) {
	//console.log("before formatDBStates4ST:", device_states);
	//console.log(device_states);
	var states = [];
	var attributes = [];
	for(let each_state of device_states) {
		var state = {};
		state.component = 'main';
		state.capability = api.findCapabilityFromAttribute(each_state.attribute);
    state.attribute = each_state.attribute;
    //console.log("state:", state, "each_state:", each_state);
    state = api.sanitizeValue(state, each_state);
    //console.log("after sanitizeValue:", state);
		states.push(state);
		attributes.push(each_state.attribute);
	}
	// make up the discrepancy of capabilities between SmartThings and local, this is because SmartThings and DeviceConnector may identify different attributes for the same devices; 
	// to integrate SmartThings, we try to match the most possible DHT based on identified attributes by constructing modified DHT2Capabilities_local;
	// however, to report states, capabilities must match the DHT; hence, we make up the missed capabilities.
	const dht = api.findDeviceHandlerTypeFromAttributes(attributes); // find the device handler type that the state is related to;

	let capabilities = [];
	for(let attr of attributes) {
	  capabilities.push(api.findCapabilityFromAttribute(attr));
	}
	const capabilities_ST = api.DHT2Capabilities_ST[dht];

	const missed_capabilities = capabilities_ST.filter(cap => !capabilities.includes(cap));
	var cap;
	for(cap of missed_capabilities) {
		const missed_attrs = api.Capabilities2Attributes[cap];
		for(attr of missed_attrs) {
			var state = {};
			state.component = 'main';
			state.capability = cap;
			state.attribute = attr;
			state = api.makeupDefaultValue(state)
			states.push(state);
		}
  }
  
  let healthState = {};
  healthState.component = 'main';
  healthState.capability = 'st.healthCheck';
  healthState.attribute = 'healthStatus';
  healthState.value = 'online';

  states.push(healthState);
	
	// console.log("after formatDBStates4ST:", states);
	return states;
}


// format the deviceState for state callback
function formatEvent4ST(event) {
	return new Promise((resolve, reject) => {
		devicestate = {};
		devicestate["externalDeviceId"] = event.device.uid;
		var attributes = [];

		if(event.device.hasOwnProperty('attributes')) { // event is from cloud-connected devices
			attributes = event.device.attributes;
		} else { // event is from openHAB-connected devices
			var item;
			for(item of event.device.items) {
				attributes.push(item.category);
			}
		}

		// assemble the states
		var states = [];
		var promises = [];
		for(let attr of attributes) {
			if (attr === event.attribute) {
				let state = {};
				state.component = 'main';
				state.capability = api.findCapabilityFromAttribute(attr);
				state.attribute = attr;
				source = {};
				source.value = event.value;
				state = api.sanitizeValue(state, source);
				states.push(state); 
			} else {
				// attributes other than the event attribute
				promises.push(db.getState(event.device.uid, attr));
			}
		}
		Promise.all(promises).then((data) => {
			//console.log("data:", data);
			var each;
			for(each of data) {
				var state = {};
				//console.log(each);
				const capability = api.findCapabilityFromAttribute(each.attribute);
				//console.log(capability);
				if(capability) {
					state.component = 'main';
					state.capability = capability;
					state.attribute = each.attribute;
					state = api.sanitizeValue(state, each);
					states.push(state); 
				} else {
					throw("failed to find the corresponding capability of attribute: ", each.attribute);
				}
			}
			//console.log("test: ", states)
			// make up the discrepancy of capabilities between SmartThings and local, this is because SmartThings and DeviceConnector may identify different attributes for the same devices; 
			// to integrate SmartThings, we try to match the most possible DHT based on identified attributes by constructing modified DHT2Capabilities_local;
			// however, to report states, capabilities must match the DHT; hence, we make up the missed capabilities.
			const dht = api.findDeviceHandlerTypeFromAttributes(attributes); // find the device handler type that emits the event;
			let capabilities = [];
			for(let attr of attributes) {
				capabilities.push(api.findCapabilityFromAttribute(attr));
			}
			const capabilities_ST = api.DHT2Capabilities_ST[dht];

			const missed_capabilities = capabilities_ST.filter(cap => !capabilities.includes(cap));

			// console.log("missed_capabilities:", missed_capabilities);
			
			var cap;
			for(cap of missed_capabilities) {
				const missed_attrs = api.Capabilities2Attributes[cap];
				for(attr of missed_attrs) {
					var state = {};
					state.component = 'main';
					state.capability = cap;
					state.attribute = attr;
					state = api.makeupDefaultValue(state)
					states.push(state);
				}
			}
			devicestate["states"] = states;
			//console.log("event:", JSON.stringify(event), "deviceState:", [devicestate], "states:", devicestate.states);
			resolve([devicestate]);
		}).catch(err => { console.error(err); })
	});
}



function formatDevice4ST(device) {
	//console.log("formatDevice4ST", device);
  var attributes = [];
  if(device.hasOwnProperty('attributes')) {
	attributes = device.attributes;
  } else {
	for(let item of device.items) {
		attributes.push(item.category);
	}
  }

  const dht = api.findDeviceHandlerTypeFromAttributes(attributes);

  if(dht) {
    var newdevice = new DiscoveryDevice(device.uid, device.label.split('_')[0], dht); // suffix of device labels are removed before sent to platform
    newdevice.manufacturerName('default');
    newdevice.modelName('default');
    newdevice.hwVersion('default');
    newdevice.swVersion('default');
    return [newdevice];
  } else {
    console.error('cannot find the device handler type of device with attributes: ', attributes);
  }
}



function test() {
	const before1 = [
		{
		  device_id: 'd801f89e-e621-4b92-85b3-4bf452e12584',
		  label: 'HwLeakSensor22smartthings',
		  attribute: 'temperature',
		  value: '24.59'
		},
		{
		  device_id: 'd801f89e-e621-4b92-85b3-4bf452e12584',
		  label: 'HwLeakSensor22smartthings',
		  attribute: 'water',
		  value: 'dry'
		}
	]
	const before2 = [
		{
		  device_id: 'd073d5566fcd',
		  label: 'FrontLight_smartthings',
		  attribute: 'switch',
		  value: 'off'
		}
	  ];

	const before3 = [
		{
		  device_id: 'Dimmable light1',
		  label: 'HTDeskHue_smartthing',
		  attribute: 'switch',
		  value: 'on'
		}
	  ]
	const before4 = [
		{
		  device_id: 'ZLLPresence2',
		  label: 'LivingRoomHueMotion_smartthings',
		  attribute: 'motion',
		  value: 'active'
		}
	  ]
	
	formatDBStates4ST(before4);
}

  

if (typeof require !== 'undefined' && require.main === module) {
	test();

}




module.exports = {
  router_connector_ST: router,
  formatEvent4ST: formatEvent4ST,
  formatDevice4ST: formatDevice4ST
};
