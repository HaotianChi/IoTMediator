const db = require('./db.js');
const internetAvailable = require("internet-available");

db.open();

const utility = {

	extractAccessToken(req) {
		try {
			let authorization = req.headers.authorization.split(' ')[1];
			console.log(authorization);
			return authorization; 
		} catch (error) {
			console.log(error);
			return undefined;
		}
	},


	monitorInternetConnetions() {
        setInterval(() => {
            internetAvailable({
                timeout:4000,
                retries:2
            })
            .then(() => {
                db.insertConnection(1);
            }).catch(() => {
                db.insertConnection(0);
            })
        }, 5000);
	},


    getHueDeviceIdLastDigit(device) {
        if(device instanceof Object && Object.keys(device).includes('id')) {
            return device.id.substring(device.id.length-1);
        } else {
            console.log('The device is not well defined!!!');
        }
    },
    
    getHueId(deviceid) {
        return deviceid.substring(deviceid.length-1);
    },
    
    print_list: function(list) {
        var item;
        for(item of list) {
            console.log(item);
        }
    },

    hasSameElements: function(list1, list2) {
        if(list1.length == list2.length && list1.every((v)=> list2.indexOf(v) >= 0)) {
            return true;
        } else {
            return false;
        }
    },

    generateUniqueId: function () {
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
          var r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
          return v.toString(16);
        });
    },

    validateAccessToken: function(platform, token) {
        console.log("validateAccessToken is called...")
        return new Promise((resolve, reject) => {
            db.getAuthenticationToken(platform).then(data => {
                if(!data) {
                    console.error("cannot find the access token in database")
                    resolve(false);
                } 
                //console.log(data.access_token, token);
                if(data.access_token === token) {
                    resolve(true);
                }
                resolve(false);
            }).catch(err => {console.error(err); resolve(false); })
        });
    },

    sanitizeEventValue: function(event) { // obj is state or event
        let res;
		switch(event.attribute) {
			case 'switch':
                res = ["on", "ON"].includes(event.value) ? 'on' : 'off';
				break;
			case 'contact':
				res = ["open", "OPEN"].includes(event.value) ? 'open' : 'closed';
				break;
			case 'presence':
				res = (event.value == 'ON') ? 'present': 'not present';
				break;
			case 'power':
                res = parseInt(event.value.toString().split(' ')[0], 10);
			    break;
			case 'temperature':
				var tmp = event.value.toString().split(' ')[0];
                res = parseFloat(tmp);
				break;
			case 'humidity':
				var tmp = event.value.toString().split(' ')[0];
				res = parseInt(tmp, 10);
				break;
			case 'motion':
				if(event.value == 'ON') res = 'active';
				else if(event.value == 'OFF') res = 'inactive';
				else res = event.value;
				break;
			case 'battery':
				res = parseInt(event.value, 10);
				break;
			case 'water':
				res = ["ON", "wet"].includes(event.value)? 'wet': 'dry';
                break;
            case 'illuminance':
				var tmp = event.value.toString().split(' ')[0];
				res = parseFloat(tmp);
                break; 
            case 'level':
                var tmp = event.value.toString().split(' ')[0];
                res = parseInt(tmp);
                break;
            case 'button_group':
                res = event.value.toString().split(' ')[0];
                break; 
            default:
                console.log("default value: ", event.attribute, event.value);
                res = event.value;
        }
		return res;
	}
}


if (typeof require !== 'undefined' && require.main === module) {
    //console.log(utility.generateUniqueId());
    utility.monitorInternetConnetions();
}


module.exports = utility;
