const request = require('request');
const config = require('../../config/default');
const utility = require('../core/utility');



module.exports = {
  push_device_state: function (deviceState) {
    //console.log("pushed an event...", deviceState[0].states);//
    const body = {};
    body.deviceState = deviceState;
    const url = config.local + '/smartthings/api/stateupdate';
    request.post(url, 
    {
      json: body
    }, (err, res, body) => {
      if (err) {
        return console.error(err);
      }
      return;
    });    
  },
  
  
  push_device_discovery: function(devices) {
    const body = {};
    body.devices = devices;
    const url = config.local + '/smartthings/api/discoveryupdate';
    request.post(url, {
      json: body
    }, (err, res, body) => {
      if (err) {
        return console.error(err);
      }
    }); 
  },


  // used for mapping local devices to DHT on SmartThings
  DHT2Capabilities_local: {
    'c2c-arrival-3':	[['st.presenceSensor']],
    'c2c-contact':	[['st.contactSensor', 'st.temperatureMeasurement']], // st.battery is omitted
    'c2c-switch':	[['st.switch']],
    'c2c-switch-power':	[['st.switch', 'st.powerMeter']],
    'c2c-leak': [['st.waterSensor', 'st.temperatureMeasurement'], ['st.waterSensor', 'st.temperatureMeasurement', 'st.relativeHumidityMeasurement']],
    'c2c-motion-2': [['st.motionSensor', 'st.battery'], ['st.motionSensor']],
    'c2c-motion': [['st.motionSensor', 'st.temperatureMeasurement']],
    'c2c-motion-5': [['st.motionSensor', 'st.temperatureMeasurement', 'st.illuminanceMeasurement']],
  },


  // real mapping defined by SmartThings, used for formating state refresh and state callback responses
  DHT2Capabilities_ST: {
    'c2c-arrival-3':	['st.presenceSensor'],
    'c2c-contact':	['st.contactSensor', 'st.battery', 'st.temperatureMeasurement'], // st.battery is omitted
    'c2c-switch':	['st.switch'],
    'c2c-switch-power':	['st.switch', 'st.powerMeter'],
    'c2c-leak': ['st.waterSensor', 'st.temperatureMeasurement', 'st.battery'],
    'c2c-motion-2': ['st.motionSensor', 'st.battery'],
    'c2c-motion': ['st.motionSensor', 'st.battery', 'st.temperatureMeasurement'],
    'c2c-motion-5': ['st.motionSensor', 'st.battery', 'st.temperatureMeasurement', 'st.illuminanceMeasurement', 'st.tamperAlert']
  },

  Capabilities2Attributes: {
	'st.motionSensor': ['motion',],
    'st.contactSensor': ['contact',],
    'st.presenceSensor': ['presence',],
    'st.powerMeter': ['power',],
    'st.switch': ['switch',],
    'st.temperatureMeasurement': ['temperature',],
    'st.battery': ['battery'],
    'st.waterSensor': ['water'],
    'st.relativeHumidityMeasurement': ['humidity'],
    'st.switchLevel': ['level'],
    'st.illuminanceMeasurement': ['illuminance'],
    'st.tamperAlert': ['tamper'],
  },

	sanitizeValue: function(output, source) { // obj is state or event
		switch(output.attribute) {
			case 'switch':
        output.value = ["on", "ON"].includes(source.value) ? 'on' : 'off';
				break;
			case 'contact':
				output.value = ["open", "OPEN"].includes(source.value) ? 'open' : 'closed';
				break;
			case 'presence':
				output.value = (source.value == 'ON') ? 'present': 'not present';
				break;
			case 'power':
				output.value = parseInt(source.value.toString().split(' ')[0], 10);
				output.unit = 'W';
			break;
			case 'temperature':
				var tmp = source.value.toString().split(' ')[0];
        tmp = parseFloat(tmp);
        output.value =  tmp;
				output.unit = 'C';
				// output.value =  tmp*1.8 + 32; // convert C to F
				// output.unit = 'F';
				break;
			case 'humidity':
				var tmp = source.value.toString().split(' ')[0];
				tmp = parseInt(tmp, 10);
				output.value = tmp;
				output.unit = '%';
				break;
			case 'motion':
				//output.value = ["ON", "active"].includes(source.value) ? 'active' : 'inactive';
				if(source.value == 'ON') output.value = 'active';
				else if(source.value == 'OFF') output.value = 'inactive';
				else output.value = source.value;
				break;
			case 'battery':
				output.value = parseInt(source.value, 10);
				output.unit = '%';
				break;
			case 'water':
				output.value = ["ON", "wet"].includes(source.value)? 'wet': 'dry';
        break;
      case 'illuminance':
				var tmp = source.value.toString().split(' ')[0];
				tmp = parseFloat(tmp);
				output.value = tmp;
				output.unit = 'lux';
        break; 
      case 'level':
          var tmp = source.value.toString().split(' ')[0];
          tmp = parseInt(tmp);
          output.value = tmp;
          output.unit = '%';
          break; 
			default:
				console.log("default value: ", source);
				output.value = source.value;
		}
		return output;
	},

	makeupDefaultValue: function(output) { // obj is state or event
		switch(output.attribute) {
			case 'motion':
				output.value = "inactive";
				break;
			case 'switch':
				output.value = "off";
				break;
			case 'contact':
				output.value = 'closed';
				break;
			case 'presence':
				output.value = 'not present';
				break;
			case 'power':
				output.value = 0;
				output.unit = 'W';
				break;
			case 'temperature':
				output.value = 100;
				output.unit = 'C';
				break;
			case 'humidity':
				output.value = 0;
				output.unit = '%';
				break;
			case 'motion':
				output.value = 'inactive';
				break;
			case 'battery':
				output.value = 50;
				output.unit = '%';
				break;
			case 'water':
				output.value = 'dry';
        break;
      case 'illuminance':
        output.value = 0;
        output.unit = 'lux';
        break;
      case 'level':
          output.value = 100;
          output.unit = '%';
          break;
      case 'tamper':
          output.value = 'clear';
          break;
			default:
				console.error("unknown default value for attribute: ", output.attribute);
		}
		return output;
	},

  findDeviceHandlerTypeFromAttributes: function(attributes) {
    for(let dht in this.DHT2Capabilities_local) {
      //console.log(dht);
      for(let capabilities of this.DHT2Capabilities_local[dht]) {
        var attrs = [];
        for(let cap of capabilities) {
          //console.log(this.Capabilities2Attributes[cap])
          attrs = attrs.concat(this.Capabilities2Attributes[cap]) // attrs matched to DHT
        }
        //console.log(attrs);
        if(utility.hasSameElements(attributes, attrs)) {
          return dht;
        }
      }
    }
    // cannot find a match
    console.error("cannot find a C2C device type match on SmartThings for attribute combination:", attributes);
    return
  },

  findCapabilityFromAttribute: function(attribute) {
      var cap;
      for(cap in this.Capabilities2Attributes) {
        if(this.Capabilities2Attributes[cap].includes(attribute)) {
          return cap;
        }
      }
      return;
  },

  command2ItemCommand: function(command) {
    const method = command.command;
    const capability = command.capability;
    const arguments = command.arguments;
    var itemCommand = {category: undefined, method: undefined, arguments: undefined};
    switch(method) {
        case 'on':
          if(capability === 'st.switch') {
            itemCommand.category = 'switch';
            itemCommand.method = 'ON';
          }
          break;
        case 'off':
          if(capability === 'st.switch') {
            itemCommand.category = 'switch';
            itemCommand.method = 'OFF';
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
    return itemCommand;
  },


  command2CloudCommand: function(command) {
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
  },


  /*
   // todo: complete the mapping table
  DHT2Capabilities = {
    'c2c-arrival':	Presence Sensor, Battery,
    'c2c-arrival-2':	Presence Sensor, Battery, Tone,
    'c2c-arrival-3':	Presence Sensor,
    'c2c-button':	Button,
    'c2c-button-2':	Button, Battery,
    'c2c-button-3':	Button, Holdable Button,
    'c2c-button-4':	Button, Holdable Button, Battery,
    'c2c-camera':	Video Camera, Video Capture, Buffered Video Capture, Switch,
    'c2c-camera-2':	Image Capture,
    'c2c-camera-3':	Video Camera, Video Capture, Video Stream, Motion Sensor, Signal Strength, Switch,
    'c2c-camera-4':	Video Camera, Video Capture, Video Stream, Motion Sensor, Signal Strength, Switch, Sound Sensor,
    'c2c-camera-5':	Video Camera, Video Capture, Video Stream, Motion Sensor, Signal Strength, Switch, Sound Sensor, Battery,
    'c2c-carbon-monoxide':	Carbon Monoxide Detector,
    'c2c-carbon-monoxide-2':	Carbon Monoxide Detector, Battery, Tamper Alert,
    'c2c-carbon-monoxide-3':	Carbon Monoxide Detector, Battery,
    'c2c-color-temperature-bulb':	Switch, Switch Level, Color Temperature,
    'c2c-contact':	Contact Sensor, Battery, Temperature Measurement,
    'c2c-contact-2':	Contact Sensor, Battery, Temperature Measurement, Acceleration Sensor,
    'c2c-contact-3':	Contact Sensor, Battery,
    'c2c-contact-4':	Contact Sensor, Door Control, Garage Door Control,
    'c2c-contact-5':	Contact Sensor, Battery, Tamper Alert,
    'c2c-dimmer':	Switch, Switch Level,
    'c2c-dimmer-2':	Switch, Switch Level, Battery,
    'c2c-dimmer-3':	Switch, Switch Level, Battery, Temperature Measurement,
    'c2c-dimmer-energy':	Switch, Switch Level, Energy Meter,
    'c2c-dimmer-power':	Switch, Switch Level, Power Meter,
    'c2c-dimmer-power-energy':	Switch, Switch Level, Power Meter, Energy Meter,
    'c2c-doorbell':	Button, Motion Sensor, Battery,
    'c2c-doorbell-2':	Button, Motion Sensor, Switch, Image Capture,
    'c2c-doorbell-3':	Button, Motion Sensor,
    'c2c-fan-controller-2speed':	Switch, Fan Speed[1,2],
    'c2c-fan-controller-3speed':	Switch, Fan Speed[1,2,3],
    'c2c-fan-controller-4speed':	Switch, Fan Speed[1,2,3,4],
    'c2c-humidity':	Relative Humidity Measurement, Battery, Temperature Measurement,
    'c2c-humidity-2':	Relative Humidity Measurement, Battery,
    'c2c-leak':	Water Sensor, Battery, Temperature Measurement,
    'c2c-leak-2':	Water Sensor, Battery,
    'c2c-leak-3':	Water Sensor, Battery, Temperature Measurement, Tamper Alert,
    'c2c-lock-2':	Lock, Battery,
    'c2c-lock-3':	Lock, Battery, Temperature Measurement,
    'c2c-motion':	Motion Sensor, Battery, Temperature Measurement,
    'c2c-motion-2':	Motion Sensor, Battery,
    'c2c-motion-3':	Motion Sensor, Battery, Temperature Measurement, Acceleration Sensor, Illuminance Measurement, Tamper Alert, Ultraviolet Index,
    'c2c-motion-4':	Motion Sensor, Battery, Temperature Measurement, Acceleration Sensor, Illuminance Measurement,
    'c2c-motion-5':	Motion Sensor, Battery, Temperature Measurement, Illuminance Measurement, Tamper Alert,
    'c2c-motion-6':	Motion Sensor, Battery, Temperature Measurement, Relative Humidity Measurement, Illuminance Measurement,
    'c2c-motion-7':	Motion Sensor, Battery, Temperature Measurement, Relative Humidity Measurement, Illuminance Measurement, Ultraviolet Index, Power Source, Tamper Alert,
    'c2c-music-player':	Music Player, Switch,
    'c2c-music-player-2':	Music Player, Switch, Audio Notification,
    'c2c-rgb-color-bulb':	Switch, Switch Level, Color Control,
    'c2c-rgbw-color-bulb':	Switch, Switch Level, Color Control, Color Temperature,
    'c2c-shade':	Window Shade, Switch, Switch Level,
    'c2c-siren':	Alarm, Switch,
    'c2c-siren-2':	Alarm,
    'c2c-siren-3':	Alarm, Switch, Battery,
    'c2c-smoke':	Smoke Detector, Battery,
    'c2c-smoke-2':	Smoke Detector,
    'c2c-smoke-co':	Carbon Monoxide Detector, Smoke Detector, Battery,
    'c2c-smoke-co-2':	Carbon Monoxide Detector, Smoke Detector,
    'c2c-smoke-co-3':	Carbon Monoxide Detector, Smoke Detector, Battery, Power Source, Color Control, Switch, Switch Level, Relative Humidity Measurement, Temperature Measurement,
    'c2c-switch':	Switch,
    'c2c-switch-energy':	Switch, Energy Meter,
    'c2c-switch-power':	Switch, Power Meter,
    'c2c-switch-power-energy':	Switch, Power Meter, Energy Meter,
    'c2c-switch-presence':	Switch, Presence Sensor,
    'c2c-valve':	Valve,
    'c2c-valve-2':	Valve, Battery, Power Source,
    'c2c-valve-3':	Valve, Switch,
  },

  Capabilities2Attributes: {

  },
  */

}

if (typeof require !== 'undefined' && require.main === module) {
  const re = module.exports.findDeviceHandlerTypeFromAttributes(['power', 'switch']);
  if (config.verbose) console.debug(re);
}