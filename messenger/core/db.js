	const sqlite3 = require('sqlite3').verbose();
	const fs = require('fs');
	const path = require('path');
	const Account = require('./account');
	const randtoken = require('rand-token');
	const deviceConnector = require('../connectors/device/device-connector');
	const config = require('../../config/default');

	let VERBOSE = config.verbose;

	const TABLES = [
		'tokens', 'urls'
	];

	const Database = {
		
	db: null,
	open: function() {
	if (this.db) {
		return;
	}
	let filename;
	let exists = false;
	filename = path.join(config.__basedir, 'db.pfirewall.sqlite3');

	// let removeBeforeOpen = false;
	let removeBeforeOpen = config.removeBeforeOpen;

	// if(config.mode === 'dev') {
	//   removeBeforeOpen = true;
	// } else {
	//   removeBeforeOpen = false;
	// }

	// Check if database already exists
	exists = fs.existsSync(filename);
	if (exists && removeBeforeOpen) {
		fs.unlinkSync(filename);
		exists = false;
	}
	console.log(exists ? 'Opening' : 'Creating', 'database:', filename);
	// Open database or create it if it doesn't exist
	this.db = new sqlite3.Database(filename);
	// Set a timeout in case the database is locked. 10 seconds is a bit long,
	// but it's better than crashing.
	this.db.configure('busyTimeout', 10000);

	this.db.serialize(() => {
		this.createTables();
	});
	},

	createTables: function() {
		// create authentication table, recording the tokens that have been issued to external platforms.
		this.db.run('CREATE TABLE IF NOT EXISTS Authentication (' +
			'client_id TEXT,' +
			'platform TEXT,' +
			'code TEXT,' +
			'access_token TEXT,' +
			'refresh_token TEXT,' +
			'expires_in TEXT,' +
			'expires TEXT,' +
			'primary key (platform)' +
		');', (err) => {
			if(err) {
			console.error('error creating table Authentication: ' + err);
			}
		});

		// create tokens table, recording tokens obtained from external platforms.
		// oauthToken is a legacy field kept for backward compatibility.
		this.db.run('CREATE TABLE IF NOT EXISTS Tokens (' +
			'platform TEXT,' +
			'keyword TEXT,' +
			'accessToken TEXT,' +
			'refreshToken TEXT,' +
			'expiresIn TEXT,' +
			'oauthToken TEXT,' +
			'stateCallback TEXT,' +
			'primary key (platform, keyword)' +
		');', (err) => {
			if(err) {
			console.error('error creating table Tokens: ' + err);
			}
		});


		// create PTokens table, the tokens obtained from platforms, client_id: client_id of the target platform
		this.db.run('CREATE TABLE IF NOT EXISTS PTokens (' +
			'client_id TEXT,' +
			'platform TEXT,' +
			'keyword TEXT,' +
			'access_token TEXT,' +
			'refresh_token TEXT,' +
			'expires_in TEXT,' +
			'token_url TEXT,' +
			'callback_url TEXT,' +
			'primary key (platform)' +
			');', (err) => {
			if(err) {
				console.error('error creating table PTokens: ' + err);
			}
		});

		// create devices table (device_id, attributes)
		this.db.run('CREATE TABLE IF NOT EXISTS Devices (' +
			'device_id TEXT,' +
			'label TEXT,' +
			'target_platform TEXT,' +
			'thingTypeUID TEXT,' +
			'attributes TEXT,' +
			'is_cloud_device BIT NOT NULL DEFAULT 0,' +
			'source TEXT,' +
			'primary key (device_id)' +
		');', (err) => {
			if(err) {
			console.error(`error creating table Devices: ` + err);
			}
		});

		// create device current states table (device_id, attribute, value, t)
		this.db.run('CREATE TABLE IF NOT EXISTS States (' +
			'device_id TEXT,' +
			'label TEXT,' +
			'attribute TEXT,' +
			'value TEXT,' +
			'primary key (device_id, attribute),' +
			'foreign key (device_id) references Devices(device_id)' +
		');', (err) => {
			if(err) {
			console.error(`error creating table States: ` + err);
			}
		});
		

		// create device events table (id, device_id, attribute, value, t)
		this.db.run('CREATE TABLE IF NOT EXISTS Events (' +
			'id INTEGER PRIMARY KEY AUTOINCREMENT,' +
			'device_id TEXT,' +
			'label TEXT,' +
			'attribute TEXT,' +
			'value TEXT,' +
			'timestamp TEXT,' +
			'locale_time TEXT,' +
			'foreign key (device_id) references Devices(device_id)' +
		');', (err) => {
			if(err) {
			console.error(`error creating table Events: ` + err);
			}
		});

		// create device command log table (id, device_id, attribute, value, platform, t)
		this.db.run('CREATE TABLE IF NOT EXISTS Commands (' +
			'id INTEGER PRIMARY KEY AUTOINCREMENT,' +
			'device_id TEXT,' +
			'label TEXT,' +
			'attribute TEXT,' +
			'value TEXT,' +
			'platform TEXT,' +
			'timestamp TEXT,' +
			'locale_time TEXT,' +
			'foreign key (device_id) references Devices(device_id)' +
		');', (err) => {
			if(err) {
			console.error(`error creating table Commands: ` + err);
			}
		});

		// create device events table (id, device_id, attribute, value, t)
		this.db.run('CREATE TABLE IF NOT EXISTS Accounts (' +
			'username TEXT PRIMARY KEY,' +
			'salt TEXT,' +
			'password TEXT,' +
			'uid TEXT' +
		');', (err) => {
			if(err) {
			console.error(`error creating table Accounts: ` + err);
			}
		});

		// create device events table (id, device_id, attribute, value, t)
		this.db.run('CREATE TABLE IF NOT EXISTS Connections (' +
			'id INTEGER PRIMARY KEY AUTOINCREMENT,' +
			'status BIT NOT NULL DEFAULT 1,' +
			'timestamp TEXT,' +
			'locale_time TEXT' + 
		');', (err) => {
			if(err) {
			console.error(`error creating table Connections: ` + err);
			}
		});
		
		// create triggers table (id, device_id, trigger_identity)
		this.db.run('CREATE TABLE IF NOT EXISTS TriggersIDs (' +
			'id INTEGER PRIMARY KEY AUTOINCREMENT,' +
			'device_id TEXT,' +
			'trigger_identity TEXT' +
		');', (err) => {
			if(err) {
				console.error(`error creating table Connections: ` + err);
			}
		});
	},

	// generate a code for issuing authorization
	initializeAuthenticationToken(username, client_id, expiresIn, platform) {
		//console.log("addAuthenticationToken is called");
		const code = randtoken.generate(16).toString();
		const accessToken = "";
		const refreshToken = "";
		const expires = expirationDate(expiresIn);
		return new Promise((resolve, reject) => {
		this.db.get('SELECT * From Authentication where platform = ?', platform, (err, row) => {
			if(err) { reject(err); }
			if(row) {
			console.error("code already exists"); 
			this.db.run(
				'UPDATE Authentication SET expiresIn=?, expires=? WHERE platform=?', [expiresIn, expirationDate(expiresIn), platform], (err) => {
					reject(err.message);
			});
			resolve(row.code);
			}
			else {
			this.db.run('INSERT INTO Authentication(client_id, platform, code, access_token, refresh_token, expires_in, expires) VALUES(?, ?, ?, ?, ?, ?, ?)', 
				[client_id, platform, code, accessToken, refreshToken, expiresIn, expires], (err) => {
				if(err) {
					console.error("error when add code", err);
					reject(err);
				}
				//console.log("added code:", code);
				resolve(code);
			});
			}
		});  
		});
	},


	addAlexaAuthenticationToken(client_id, platform, access_token) {
		return new Promise((resolve, reject) => {
			this.db.get('SELECT * From Authentication where platform = ?', platform, (err, row) => {
				if(err) { reject(err.message); }
				if(row) {
					console.log("Token already exists. Updating..."); 
					this.db.run(
						'UPDATE Authentication SET access_token=? WHERE platform=?', 
						[access_token, platform], (err) => {
							reject(err);
					});
					resolve();
				}
				else {
					this.db.run('INSERT INTO Authentication(client_id, platform, code, access_token, refresh_token, expires_in, expires) VALUES(?, ?, ?, ?, ?, ?, ?)', 
						[client_id, platform, null, access_token, null, null, null], (err) => {
						if(err) {
							console.error("error when add authentication", err.message);
							reject(err);
						}
						resolve();
					});
				}
			});  
		})
	},


	getAuthenticationToken(platform) {
	return new Promise((resolve, reject) => {
		this.db.get('SELECT * From Authentication where platform = ?', platform, (err, row) => {
		if(err) {
			reject(err.message);
		} else {
			if(!row) {
			reject(`Cannot find entries with platform = ${platform}`) 
			}
			resolve(row);
		}
		});
	});
	},


	redeemAuthenticationCode(platform) {
		return new Promise( (resolve, reject) => {
			this.getAuthenticationToken(platform).then(row => {
				const now = new Date().getTime()/1000;
				if (now > row.expires) {
					reject("The authorization code expires");
				} else {
					const access_token = randtoken.generate(24).toString();
					const refresh_token = row.code;
					const expires = expirationDate(row.expires_in);
					this.db.run(
					'UPDATE Authentication SET access_token=?, refresh_token=?, expires=? WHERE platform=?', [access_token, refresh_token, expires, platform], (err) => {
						if(err) { reject(err); }
						else {
							resolve({client_id: row.client_id, platform: row.platform, access_token: access_token, refresh_token: refresh_token, expires_in: row.expires_in, expires:expires, token_type: 'Bearer'});
						}
					});
				}
			});
		});
	},


	// refreshAuthenticationToken(client_id, refreshToken) {
	//   return new Promise( (resolve, reject) => {
	//     this.db.get('SELECT * From Authentication where client_id = ? and refresh_token = ?', [client_id, refreshToken], (err, row) => {
	//       if(err) {
	//           reject(err.message);
	//       } else {
	//         if(!row) {
	//           reject(`Cannot find entries with client_id = ${client_id} and refresh_token = ${refreshToken}`);
	//         } 
	//         row.accessToken = randtoken.generate(24);
	//         this.db.run(
	//           'UPDATE Authentication SET access_token=?, expires=? WHERE client_id=? and refresh_token=?', [row.accessToken, expirationDate(row.expiresIn), client_id, refreshToken], (err) => {
	//               reject(err.message);
	//           });
	//         return row;
	//       }
	//     });
	//   });
	// },



	async addAccount(username, password) {
	await this.db.get('SELECT * From Accounts where username = ?', username, (err, row) => {
		if(err) { console.error(err.message); }
		if(row) { console.error("username already exists"); }
		else {
			const account = new Account().initialize(username, password);
			this.db.run('INSERT INTO Accounts(username, password, salt, uid) VALUES(?, ?, ?, ?)', [account.username, account.password, account.salt, account.uid], (err) => {
			if(err) { console.error(err); }
			else {
				return account;
			}
			});
		}  
	});
	},


	getAccount(username) {
	return new Promise((resolve, reject) => {
		this.db.get('SELECT * From Accounts where username = ?', username, (err, row) => {
		if(err) {
			console.error(err.message);
			reject(err.message);
		} else {
			if(!row) {
			console.error(`Cannot find account with username: ${username}`);
			reject(`Cannot find account with username: ${username}`);
			} 
			const account = new Account().fromDb(row);
			resolve(account);
		}
		});
	});
	},

	// use the first account as default user
	getDefaultAccount() {
	return new Promise((resolve, reject) => {
		this.db.get('SELECT * From Accounts', (err, row) => {
		if(err) {
			reject(err.message);
		} else {
			if(!row) {
			reject(`Cannot find account`);
			} 
			const account = new Account().fromDb(row);
			delete account.password;
			delete account.salt;
			resolve(account);
		}
		});
	});
	},


	// Legacy token update path for compatibility with older integrations.
	updateTokens(accessTokens) {
	return new Promise((resolve, reject) => {
		var t;
		for (t in accessTokens) {
		this.db.get('SELECT * From Tokens where keyword = ?', t, (err, row) => {
			if(err) { reject(err); }
			if(row) {
				this.db.run('DELETE FROM Tokens WHERE keyword = ?', t, (err) => {
					if(err) { reject(err); }
					else {
						this.db.run('INSERT INTO Tokens(keyword, accessToken, refreshToken, expiresIn, oauthToken, stateCallback) VALUES(?, ?, ?, ?, ?, ?)', 
						[t, 
							accessTokens[t]['callbackAuthentication']['accessToken'], 
							accessTokens[t]['callbackAuthentication']['refreshToken'], 
							accessTokens[t]['callbackAuthentication']['expiresIn'], 
							accessTokens[t]['callbackUrls']['oauthToken'], 
							accessTokens[t]['callbackUrls']['stateCallback']], (err) => {
							if(err) { reject('error adding entry1: ' + err); }
							resolve();
						});
					}
				});
			} else {

				this.db.run('INSERT INTO Tokens(keyword, accessToken, refreshToken, expiresIn, oauthToken, stateCallback) VALUES(?, ?, ?, ?, ?, ?)', 
					[t, 
					accessTokens[t]['callbackAuthentication']['accessToken'], 
					accessTokens[t]['callbackAuthentication']['refreshToken'], 
					accessTokens[t]['callbackAuthentication']['expiresIn'], 
					accessTokens[t]['callbackUrls']['oauthToken'], 
					accessTokens[t]['callbackUrls']['stateCallback']], (err) => {
					if(err) {
						reject('error adding entry2: ' + err);
					}
					resolve();
				});
			}
		});
		}
	});  
	},

	// update tokens for accessing platforms
	updatePToken(token) {
	return new Promise((resolve, reject) => {
		var keyword;
		if(Object.keys(token).includes('keyword')) { keyword = token.keyword; } else { keyword = "" }
		this.db.run('DELETE FROM PTokens WHERE platform = ?', token.platform, (err) => {
			if(err) { reject(err); }
			else {
			this.db.run('INSERT INTO PTokens(client_id, platform, keyword, access_token, refresh_token, expires_in, token_url, callback_url) VALUES(?, ?, ?, ?, ?, ?, ?, ?)', 
				[token.client_id, token.platform, keyword, token.access_token, token.refresh_token, token.expires_in, token.token_url, token.callback_url], (err) => {
				if(err) { reject('error adding entry: ' + err); }
				resolve();
			});
			}
		});
	});  
	},

	// query tokens
	getPToken: function(platform) {
	return new Promise( (resolve, reject) => {
		this.db.get(
		'SELECT * FROM PTokens WHERE platform=?', platform, (err, row) => {
			if (err) {
			return console.error(err.message);
			} 
			if (!row) {
			resolve();
			}
			else {
			var token = {};
			token.client_id = row.client_id;
			token.platform = row.platform;
			token.keyword = row.keyword;
			token.access_token = row.access_token;
			token.refresh_token = row.refresh_token;
			token.expires_in = row.expires_in;
			token.token_url = row.token_url;
			token.callback_url = row.callback_url;
			resolve(token);
			}
		});
	});
	},

	// insert openhab device to database
	insertDevice: function(device) {
		return new Promise((resolve, reject) => {
			this.db.get('SELECT * From Devices where device_id = ?', device.uid, (err, row) => {
				if(err) { reject(err); }
				if(row) {
					this.db.run('DELETE FROM Devices WHERE device_id = ?', device.uid, (err) => {
						if(err) { reject(err); }
						var attributes = [];
						var item;
						for(item of device.items) {
							attributes.push(item.category);
						}
						attributes = attributes.join(':');
						// Current behavior derives target platform from the device label.
						// Now assume only one target platform
						target_platform = device.label.split('_');
						target_platform = target_platform.slice(-1)[0];
						this.db.run('INSERT INTO Devices(device_id, label, target_platform, thingTypeUID, attributes, source) VALUES(?, ?, ?, ?, ?, ?)', [device.uid, device.label, target_platform, device.thingTypeUID, attributes, device.source], (err) => {
							if(err) { reject(err); }
							// cut off the information not relevant to the home automation application
							var newdevice = {}; 
							newdevice.uid = device.uid;
							newdevice.label = device.label;
							newdevice.typeUID = device.thingTypeUID;
							newdevice.platform = target_platform;
							newdevice.source = device.source;
							newdevice.attributes = attributes.split(':');
							newdevice.items = device.items;
							//console.log(newdevice);
							//console.log("insertDevice:", newdevice.label);
							resolve(newdevice);
						});
					});
				} else {
					var attributes = [];
					var item;
					for(item of device.items) {
						attributes.push(item.category);
					}
					attributes = attributes.join(':');
					// Current behavior derives target platform from the device label.
					// Now assume only one target platform
					target_platform = device.label.split('_');
					target_platform = target_platform.slice(-1)[0];
					this.db.run('INSERT INTO Devices(device_id, label, target_platform, thingTypeUID, attributes, source) VALUES(?, ?, ?, ?, ?, ?)', [device.uid, device.label, target_platform, device.thingTypeUID, attributes, device.source], (err) => {
						if(err) { reject(err); }  
						// cut off the information not relevant to the home automation application
						var newdevice = {}; 
						newdevice.uid = device.uid;
						newdevice.label = device.label;
						newdevice.typeUID = device.thingTypeUID;
						newdevice.platform = target_platform;
						newdevice.source = device.source;
						newdevice.attributes = attributes.split(':');
						newdevice.items = device.items;
						//console.log(newdevice);
						//console.log("insertDevice:", newdevice.label);
						resolve(newdevice);	
					});				
				}
			});
		});
	},


	// initialize all connected openhab devices to IoTMediator, including device info., attribute info. and state info.
	initializeDevices: function(connector) {
	return new Promise((resolve, reject) => {
		// first clear the Device table
		connector.getAllDevices().then((devices) => {
			var promises = [];
			var device;
			for(device of devices) {
				promises.push(this.insertDevice(device));
			}
			Promise.allSettled(promises).then((results) => {
				//console.log("results:", results);
				var res;
				var devices = [];
				for(res of results) {
				//console.log(res)
					devices.push(res.value)
				}
				
				resolve(devices);
			}).catch(err => { reject("Error when initializing Devices" + err)} );
		});
		});
	},


	// insert cloud connected devices to database
	insertCloudDevice: function(device) {
	return new Promise((resolve, reject) => {
		this.db.get('SELECT * From Devices where device_id = ?', device.uid, (err, row) => {
			if(err) { reject(err); }
			if(row) {
				this.db.run('DELETE FROM Devices WHERE device_id = ?', device.uid, (err) => {
					if(err) { reject(err); }
					let attributes = device.attributes.join(':');
					// Current behavior assumes one target platform encoded in the device label as "_<target>" or "22<target>".
					let target_platform = device.label.split('_');
					//console.log(target_platform);
					if(target_platform.length === 1) {
						target_platform = device.label.split('22');
					if(target_platform.length !== 1) {
						target_platform = target_platform.slice(-1)[0];
						//console.log(target_platform);
					} else {
						console.error("Device label does not include a target platform suffix. Please rename the device label.", device.label);
					}
					} else {
						target_platform = target_platform.slice(-1)[0];
					}
					//console.log("final:", target_platform);
					this.db.run('INSERT INTO Devices(device_id, label, target_platform, thingTypeUID, attributes, is_cloud_device, source) VALUES(?, ?, ?, ?, ?, ?, ?)', 
					[device.uid, device.label, target_platform, device.thingTypeUID, attributes, 1, device.source], (err) => {
						if(err) { reject(err); }  
						// cut off the information not relevant to the home automation application
						var newdevice = {}; 
						newdevice.uid = device.uid;
						newdevice.label = device.label;
						newdevice.typeUID = device.thingTypeUID;
						newdevice.platform = target_platform;
						newdevice.source = device.source;
						newdevice.attributes = attributes.split(':');
						newdevice.values = device.values;
						//console.log(newdevice);
						resolve(newdevice);
					});
				});
			} else {
				let attributes = device.attributes.join(':');
				// Current behavior assumes one target platform encoded in the device label as "_<target>" or "22<target>".
				let target_platform = device.label.split('_');
				//console.log(target_platform);
				if(target_platform.length === 1) {
					target_platform = device.label.split('22');
				if(target_platform.length !== 1) {
					target_platform = target_platform.slice(-1)[0];
					//console.log(target_platform);
				} else {
					console.error("Device label does not include a target platform suffix. Please rename the device label.", device.label);
				}
				} else {
					target_platform = target_platform.slice(-1)[0];
				}
				//console.log("final:", target_platform);
				this.db.run('INSERT INTO Devices(device_id, label, target_platform, thingTypeUID, attributes, is_cloud_device, source) VALUES(?, ?, ?, ?, ?, ?, ?)', 
				[device.uid, device.label, target_platform, device.thingTypeUID, attributes, 1, device.source], (err) => {
					if(err) { reject(err); }  
					// cut off the information not relevant to the home automation application
					var newdevice = {}; 
					newdevice.uid = device.uid;
					newdevice.label = device.label;
					newdevice.typeUID = device.thingTypeUID;
					newdevice.platform = target_platform;
					newdevice.source = device.source;
					newdevice.attributes = attributes.split(':');
					newdevice.values = device.values;
					//console.log(newdevice);
					resolve(newdevice);
				});				
			}
		});
	});
	},


	// initialize all cloud connected devices
	initializeCloudDevices: function(cloudConnector) {
		console.log("Initializing cloud devices...");
		return new Promise((resolve, reject) => {
			// first clear the Device table
			cloudConnector.getAllDevices(verbose=true).then((devices) => {
				var promises = [];
				var device;
				for(device of devices) {
					promises.push(this.insertCloudDevice(device));
				}
				Promise.allSettled(promises).then((results) => {
					//console.log("results:", results)
					var res;
					var devices = [];
					for(res of results) {
					//console.log(res)
					devices.push(res.value)
					}
					resolve(devices);
				}).catch(err => { reject("Error when initializing Cloud Devices" + err)} );
			});
		});
	},


	insertState: function(device, item) {
		return new Promise((resolve, reject) => {  
			this.db.get('SELECT * From States where device_id=? and attribute=?', [device.uid, item.category], (err, row) => {
				if(err) { reject(err); }
				if(row) {
					this.db.run('DELETE FROM States WHERE device_id=? and attribute=?', [device.uid, item.category], (err) => {
						if(err) reject(err);
						this.db.run('INSERT INTO States(device_id, label, attribute, value) VALUES(?, ?, ?, ?)', [device.uid, device.label, item.category, item.state], (err) => {
							if(err) { reject("Error when inserting states" + err); }  
							// cut off the information not relevant to the home automation application
							var state = {}; 
							state.uid = device.uid;
							state.label = device.label;
							state.attribute = item.category;
							state.value = item.state;
							//console.log(newdevice);
							//console.log(state)
							resolve(state);
						});
					});
				} else {
					this.db.run('INSERT INTO States(device_id, label, attribute, value) VALUES(?, ?, ?, ?)', [device.uid, device.label, item.category, item.state], (err) => {
						if(err) { reject("Error when inserting states" + err); }  
						// cut off the information not relevant to the home automation application
						var state = {}; 
						state.uid = device.uid;
						state.label = device.label;
						state.attribute = item.category;
						state.value = item.state;
						//console.log(newdevice);
						//console.log(state)
						resolve(state);
					});				
				}
			});
		});
	},

	// initialize all connected devices to IoTMediator, including device info., attribute info. and state info.
	initializeStates: function(devices) {
		return new Promise((resolve, reject) => {
		// first clear the Device table
			// connector.getAllDevices().then((devices) => {
			//   var promises = [];
			//   var device;
			//   for(device of devices) {
			//       //console.log(device);
			//       var item;
			//       for(item of device.items) {
			//           promises.push(this.insertState(device, item));
			//       }
			//   }
			//   Promise.allSettled(promises).then((results) => {
			//     var states = [];
			//     var res;
			//     for(res of results) {
			//       states.push(res.value);
			//     }
			//     //console.log(states);
			//     resolve(states);
			//   });
			// }).catch(err => { reject("Error when initializing States" + err)} );
			let promises = [];

			for(let device of devices) {
				//console.log("devices:", devices.length, devices);
				if (device != null) {
					for(let item of device.items) {
						promises.push(this.insertState(device, item));
					}
				}
			}
			Promise.allSettled(promises).then((results) => {
				let states = [];
				for(let res of results) {
					states.push(res.value);
				}
				resolve(states);
			}).catch(err => {reject("Error when initializing States" + err)});
		});
	},


	insertCloudDeviceState: function(device, attribute) {
		return new Promise((resolve, reject) => {  
			this.db.get('SELECT * From States where device_id=? and attribute=?', [device.uid, attribute], (err, row) => {
				if(err) { reject(err); }
				if(row) {
					this.db.run('DELETE FROM States WHERE device_id=? and attribute=?', [device.uid, attribute], (err) => {
						if(err) reject(err);
						this.db.run('INSERT INTO States(device_id, label, attribute, value) VALUES(?, ?, ?, ?)', [device.uid, device.label, attribute, device.values[attribute]], (err) => {
							if(err) { reject("Error when inserting states" + err); }  
							// cut off the information not relevant to the home automation application
							var state = {}; 
							state.uid = device.uid;
							state.label = device.label;
							state.attribute = attribute;
							state.value = device.values[attribute];
							//console.log(newdevice);
							//console.log(state)
							resolve(state);
						});
					});
				} else {
					this.db.run('INSERT INTO States(device_id, label, attribute, value) VALUES(?, ?, ?, ?)', [device.uid, device.label, attribute, device.values[attribute]], (err) => {
						if(err) { reject("Error when inserting states" + err); }  
						// cut off the information not relevant to the home automation application
						var state = {}; 
						state.uid = device.uid;
						state.label = device.label;
						state.attribute = attribute;
						state.value = device.values[attribute];
						//console.log(newdevice);
						//console.log(state)
						resolve(state);
					});					
				}
			});
		});
	},

	// initialize all connected devices to IoTMediator, including device info., attribute info. and state info.
	initializeCloudDeviceStates: function(devices) {
		return new Promise((resolve, reject) => {
			// cloudConnector.getAllDevices(false).then((devices) => {
			// var promises = [];
			// var device;
			// for(device of devices) {
			// 	//console.log(device);
			// 	var attribute
			// 	for(attribute of device.attributes) {
			// 		promises.push(this.insertCloudDeviceState(device, attribute));
			// 	}
			// }
			// Promise.allSettled(promises).then((results) => {
			// 	var states = [];
			// 	var res;
			// 	for(res of results) {
			// 	states.push(res.value);
			// 	}
			// 	//console.log(states);
			// 	resolve(states);
			// });
			// }).catch(err => { reject("Error when initializing Cloud Device States" + err)} );
			let promises = [];
			for(let device of devices) {
				for(let attribute of device.attributes) {
					//console.log(device.label, attribute);
					promises.push(this.insertCloudDeviceState(device, attribute));
				}
			}
			Promise.allSettled(promises).then((results) => {
				let states = [];
				for(let res of results) {
					states.push(res.value);
				}
				resolve(states);
			}).catch(err => { reject("Error when initializing Cloud Device States" + err)} );
		});
	},


	// insert to Events when a new event comes for openHAB-connected devices
	insertEvent: function(event) {
		return new Promise( (resolve, reject) => {
			this.db.run('INSERT INTO Events(device_id, label, attribute, value, timestamp, locale_time) VALUES(?, ?, ?, ?, ?, ?)', [event.device.uid, event.device.label, event.item.category, event.value, getTimestamp(), getLocaleTime()], (err) => {
				if(err) { reject(err); }
				resolve();
			});
		});
	},

	// insert to Events when a new event comes for cloud-connected devices
	insertCloudDeviceEvent: function(event) {
		return new Promise( (resolve, reject) => {
			this.db.run('INSERT INTO Events(device_id, label, attribute, value, timestamp, locale_time) VALUES(?, ?, ?, ?, ?, ?)', [event.device.uid, event.device.label, event.attribute, event.value, getTimestamp(), getLocaleTime()], (err) => {
				if(err) { reject(err); }
				resolve();
			});
		});
	},

	// insert command log when a new command comes from target platforms
	insertCommand: function(command) {
		return new Promise( (resolve, reject) => {
			this.db.run('INSERT INTO Commands(device_id, label, attribute, value, platform, timestamp, locale_time) VALUES(?, ?, ?, ?, ?, ?, ?)', [command.device.uid, command.device.label, command.attribute, command.value, command.platform, getTimestamp(), getLocaleTime()], (err) => {
				if(err) { reject(err); }
				resolve();
			});
		});
	},

	// update device State when a new event comes
	updateState(event) {
		return new Promise( (resolve, reject) => {
			this.db.run('UPDATE States SET value=? WHERE device_id=? and attribute=?', [event.value, event.device.uid, event.item.category], (err) => {
			if(err) { reject(err); }
			resolve();
			});
		});
	},


	// update device State when a new event comes
	updateCloudDeviceState(event) {
		return new Promise( (resolve, reject) => {
			this.db.run('UPDATE States SET value=? WHERE device_id=? and attribute=?', [event.value, event.device.uid, event.attribute], (err) => {
				if(err) { reject(err); }
				resolve();
			});
		});
	},

	// get device current state in table States
	getState(device_id, attribute) {
		//console.log("getting state:", device_id, attribute);
		return new Promise((resolve, reject) => {
			this.db.get('SELECT * From States where device_id=? AND attribute=?', [device_id, attribute], (err, row) => {
			if(err) { reject(err); }
			//console.log("state:", row);
			if(row) {
				resolve(row);
			} else {
				reject("Cannot find the state:", device_id, attribute);
			}    
			});
		});
	},

	getStates() {
	return new Promise((resolve, reject) => {
		this.db.all('select * From States', (err, rows) => {
			if(err) { reject(err); }
			if(rows) {
			//console.log(rows);
			resolve(rows);
			} else {
			resolve();
			}
		});
	});
	},

	getDeviceStates(id) {
	return new Promise((resolve, reject) => {
		this.db.all('select * From States WHERE device_id=?', id, (err, rows) => {
			if(err) { reject(err); }
			if(rows) {
			//console.log(rows);
			resolve(rows);
			} else {
			resolve();
			}
		});
	});
	},

	// get device current state in table States
	getDevices() {
		return new Promise((resolve, reject) => {
			this.db.all('SELECT * From Devices', (err, rows) => {
			if(err) { reject(err); }
			if(rows) {
				//console.log(rows);
				var device;
				var devices = [];
				for(device of rows) {
					var newdevice = device;
					newdevice.attributes = device.attributes.split(':');
					devices.push(newdevice);
				}
				//console.log(devices);
				resolve(devices);
			} else {
				resolve();
			}    
			});
		});
	},


	// get device current state in table States
	getDeviceIds() {
		return new Promise((resolve, reject) => {
			this.db.all('SELECT device_id From Devices', (err, rows) => {
			if(err) { reject(err); }
			if(rows) {
				let ids = []
				rows.forEach(row => {
					ids.push(row.device_id);
				})
				resolve(ids);
			} else {
				resolve();
			}    
			});
		});
	},

	// get device current state in table States
	getDevice(id) {
		return new Promise((resolve, reject) => {
			this.db.get('SELECT * From Devices WHERE device_id=?', id, (err, row) => {
				if(err) { reject(err); }
				if(row) {
					//console.log(row);
					let device = row;
					//console.log(device);
					resolve(device);
				} else {
				resolve();
				}    
			});
		});
	},

	getEventTargetPlatform(event) {
		return new Promise((resolve, reject) => {
			this.getDevice(event.device.uid).then(device => {
				if(device) {
					resolve(device.target_platform);
				} else {
					resolve();
				}
				
			})
		})
	},

	getDeviceTargetPlatform(device) {
		return new Promise((resolve, reject) => {
			this.getDevice(device.uid).then(device => {
				resolve(device.target_platform);
			})
		})
	},

	// status: 1 (connected) or 0 (disconnected)
	insertConnection(status) { 
		return new Promise( (resolve, reject) => {
			this.db.run('INSERT INTO Connections(status, timestamp, locale_time) VALUES(?, ?, ?)', [status, getTimestamp(), getLocaleTime()], (err) => {
				if(err) { reject(err); }
				resolve();
			});
		});
	},	

	// Get events based on device_id and attribute
	// limit determines how many maximum events are returned
	// ordered by timestamp descending
	// Takes in a comparison operator and uses that to get events
	getEvents(device_id, attribute, value, limit, comp_op) {
		//console.log("getting state:", device_id, attribute);
	
		// If value is specified
		if (value) {
			return new Promise((resolve, reject) => {
				let statement;
				if (comp_op == "=") {
					statement = 'SELECT * From Events where device_id=? AND attribute=? AND value=? ORDER BY timestamp DESC LIMIT ? ';
				} else if (comp_op == ">") {
					statement = 'SELECT * From Events where device_id=? AND attribute=? AND value>CAST(? as REAL) ORDER BY timestamp DESC LIMIT ? ';
				} else if (comp_op == "<") {
					statement = 'SELECT * From Events where device_id=? AND attribute=? AND value<CAST(? as REAL) ORDER BY timestamp DESC LIMIT ? ';
				} else {
					reject("Unknown comparison operator");
				}
				this.db.all(statement, [device_id, attribute, value, limit], (err, row) => {
					if(err) { reject(err); }
					//console.log("events:", row);
					if(row) {
						resolve(row);
					} else {
						reject("Cannot find the events:", device_id, attribute);
					}    
				});
			});
		} else {
			return new Promise((resolve, reject) => {
				this.db.all('SELECT * From Events where device_id=? AND attribute=? ORDER BY timestamp DESC LIMIT ? ', [device_id, attribute, limit], (err, row) => {
					if(err) { reject(err); }
					//console.log("events:", row);
					if(row) {
						resolve(row);
					} else {
						reject("Cannot find the events:", device_id, attribute);
					}    
				});
			});
		}
	},

	// Return all devices with specified attribute
	getDeviceIDsWithAttrib(attribute) {
		// If value is specified
		if (attribute) {
			return new Promise((resolve, reject) => {
				this.db.all('SELECT * From Devices where instr(attributes, ?) > 0', [attribute], (err, rows) => {
					if(err) { reject(err); }
					if(rows) {
						// console.log("ROWS: " + rows);
						let ids = []
						rows.forEach(row => {
							ids.push(row.device_id);
						})
						resolve(ids);
					} else {
						reject("Cannot find the device:", attribute);
					}    
				});
			});
		} 
	},
	
	// Gets one device with the specified attribute
	// E.g. if attribute is temperature, then get one device with that attribute
	getOneDevice(attribute) {
		return new Promise((resolve, reject) => {
			this.db.get('SELECT * From Devices where instr(attributes, ?) > 0 LIMIT 1', [attribute], (err, row) => {
				if(err) { reject(err); }
				//console.log("events:", row);
				if(row) {
					resolve(row);
				} else {
					reject("Cannot find the device:", attribute);
				}    
			});
		});
	},

	// Add a trigger identity to the database
	setTriggerIdentity(device_id, trigger_identity) {
		return new Promise((resolve, reject) => {
			this.db.run('INSERT INTO TriggersIDs(device_id, trigger_identity) VALUES(?, ?)', 
				[device_id, trigger_identity], (err) => {
				if(err) { reject('error adding entry: ' + err); }
				resolve(true);
			});
			
		});
	},

	// Return array of triggers that are tied to the device specified by device_id
	getTriggerIdentities(device_id) {
		return new Promise((resolve, reject) => {
			this.db.all('SELECT * From TriggersIDs where device_id=? ', [device_id], (err, row) => {
				if(err) { reject(err); }
				//console.log("events:", row);
				if(row) {
					resolve(row);
				} else {
					reject("Cannot find the TriggersIDs:", device_id);
				}    
			});
		});
	},

	// Return trigger_identity
	getTriggerIdentity(trigger_identity) {
		return new Promise((resolve, reject) => {
			this.db.get('SELECT * From TriggersIDs where trigger_identity=?', [trigger_identity], (err, row) => {
				if(err) { reject(err); }
				//console.log("events:", row);
				resolve(row);
			});
		});
	},

	// Delete trigger_identity
	removeTriggerID(trigger_identity) {
		return new Promise((resolve, reject) => {
			this.db.run('DELETE From TriggersIDs where trigger_identity=?', [trigger_identity], (err) => {
				if(err) { reject(err); }
				resolve(true);
			});
		});
	}

}



	function getLocaleTime() {
		const localestring = new Date().toLocaleString();
		const [date_string, time_string] = localestring.split(',');
		const new_locale_string = time_string + ', ' + date_string;
		//console.log(new_locale_string);
		return new_locale_string;
	}


	function getTimestamp() {
		return new Date();
	}


	function expirationDate(expiresIn) {
	// todo: convert the UTC time to local time; right now, all time information is based on UTC time
	return Math.round(new Date().getTime()/1000) + expiresIn;
	}


	function findDeviceFromEvent(deviceConnector, event) {
	// todo
	}


	if (typeof require !== 'undefined' && require.main === module) {
		Database.open();
		// Database.getStates().then(allStates => {
		// 	console.log(allStates);
		// });
		// let a = new Date();
		// console.log(a, a.toTimeString(), "->", a.toISOString(), "->", a.toString());
		// console.log(a.toLocaleDateString(), "->", a.toLocaleString(), "->", a.toTimeString(), "->", a.toUTCString());
		//getDateTime();
		//Database.autoUpdateConnetions();
		Database.getDeviceIds()
	}


	module.exports = Database;
