const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const path = require('path');
const randtoken = require('rand-token');
const config = require('../../config/default');

let VERBOSE = config.verbose;


const Database = {
    
    db: null,
    open: function() {
        if (this.db) {
            return;
        }
        let filename;
        let exists = false;
        filename = path.join('./', 'db.openhab.sqlite3');
        var removeBeforeOpen = false;
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
        // openhab devices
        this.db.run('CREATE TABLE IF NOT EXISTS Devices (' +
            'device_id TEXT,' +
            'label TEXT,' +
            'thingTypeUID TEXT,' +
            'attributes TEXT,' +
            'primary key (device_id)' +
        ');', (err) => {
            if(err) {
            console.error(`error creating table Devices: ` + err);
            }
        });

        // device states
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
        

        // events history
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

                        this.db.run('INSERT INTO Devices(device_id, label, thingTypeUID, attributes) VALUES(?, ?, ?, ?)', [device.uid, device.label, device.thingTypeUID, attributes], (err) => {
                            if(err) { reject(err); }  
                            // cut off the information not relevant to the home automation application
                            var newdevice = {};
                            newdevice.uid = device.uid;
                            newdevice.label = device.label;
                            newdevice.typeUID = device.thingTypeUID;
                            newdevice.attributes = attributes.split(':');
                            newdevice.items = device.items;
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
                    this.db.run('INSERT INTO Devices(device_id, label, thingTypeUID, attributes) VALUES(?, ?, ?, ?)', [device.uid, device.label, device.thingTypeUID, attributes], (err) => {
                        if(err) { reject(err); }  
                        // cut off the information not relevant to the home automation application
                        var newdevice = {};
                        newdevice.uid = device.uid;
                        newdevice.label = device.label;
                        newdevice.typeUID = device.thingTypeUID;
                        newdevice.attributes = attributes.split(':');
                        newdevice.items = device.items;
                        resolve(newdevice);
                    });			
                }
            });
        });
    },

    initializeDevices: function(devices) {
        return new Promise((resolve, reject) => {
            // first clear the Device table
            var promises = [];
            for(let device of devices) {
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
            }).catch(err => { reject("Error when initializing Devices" + err)});
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
                            if(err) { reject1("Error when inserting states" + err); }  
                            var state = {}; 
                            state.uid = device.uid;
                            state.label = device.label;
                            state.attribute = item.category;
                            state.value = item.state;
                            resolve(state);
                        });
                    });
                } else {
                    this.db.run('INSERT INTO States(device_id, label, attribute, value) VALUES(?, ?, ?, ?)', [device.uid, device.label, item.category, item.state], (err) => {
                        if(err) { reject1("Error when inserting states" + err); }  
                        var state = {}; 
                        state.uid = device.uid;
                        state.label = device.label;
                        state.attribute = item.category;
                        state.value = item.state;
                        resolve(state);
                    });				
                }
            });
        });
    },

    // initialize all connected devices to IoTMediator, including device info., attribute info. and state info.
    initializeStates: function(devices) {
        return new Promise((resolve, reject) => {
            let promises = [];
            for(let device of devices) {
                for(let item of device.items) {
                    promises.push(this.insertState(device, item));
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


    // insert to Events when a new event comes for openHAB-connected devices
    insertEvent: function(event) {
        return new Promise( (resolve, reject) => {
            this.db.run('INSERT INTO Events(device_id, label, attribute, value, timestamp, locale_time) VALUES(?, ?, ?, ?, ?, ?)', [event.device.uid, event.device.label, event.item.category, event.value, getTimestamp(), getLocaleTime()], (err) => {
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
    getDevice(id) {
        return new Promise((resolve, reject) => {
            this.db.get('SELECT * From Devices WHERE device_id=?', id, (err, row) => {
                if(err) { reject(err); }
                if(row) {
                    //console.log(row);
                    let device = row;
                    device.attributes = row.attributes.split(':');
                    //console.log(device);
                    resolve(device);
                } else {
                resolve();
                }    
            });
        });
    },
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