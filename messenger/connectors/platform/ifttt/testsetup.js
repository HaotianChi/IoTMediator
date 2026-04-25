let db = require('../../core/db.js');

const platform = 'ifttt';

function testsetup(req, res) {
    db.getAuthenticationToken(platform).then((token) => {
        let findSwitch = db
            .getOneDevice("switch")
            .catch((err) => console.log(err));

        let findTemperature = db
            .getOneDevice("temperature")
            .catch((err) => console.log(err));

        let findMotion= db
            .getOneDevice("motion")
            .catch((err) => console.log(err));

        let findContact= db
            .getOneDevice("contact")
            .catch((err) => console.log(err));

        let findPower= db
            .getOneDevice("power")
            .catch((err) => console.log(err));

        let findIlluminance= db
            .getOneDevice("illuminance")
            .catch((err) => console.log(err));

        let findLevel= db
            .getOneDevice("level")
            .catch((err) => console.log(err));

        let findHumidity= db
            .getOneDevice("humidity")
            .catch((err) => console.log(err));

        let findWet = db
            .getOneDevice("water")
            .catch((err) => console.log(err));

        let findValve = db
            .getOneDevice("valve")
            .catch((err) => console.log(err));

        let findLock = db
            .getOneDevice("lock")
            .catch((err) => console.log(err));

      return Promise.all([findSwitch, findTemperature, findMotion, findContact, findPower, findIlluminance, findLevel, findHumidity, findWet, findValve, findLock])
        .then(data =>  {
            const switch_device = data[0];
            const temperature_device = data[1];
            const motion_device = data[2];
            const contact_device = data[3];
            const power_device = data[4];
            const illuminance_device = data[5];
            const level_device = data[6];
            const humidity_device = data[7];
            const water_device = data[8];
            const valve_device = data[9];
            const lock_device = data[10];

            return res.status(200).send({
                "data": {
                  accessToken: token.access_token,
                  samples: {
                    triggers: {
                      is_wet: {
                        id_of_the_device: water_device.device_id
                      },
                      is_dry: {
                        id_of_the_device: water_device.device_id
                      },
                      contact_open: {
                        id_of_the_device: contact_device.device_id
                      },
                      contact_closed: {
                        id_of_the_device: contact_device.device_id
                      },
                      power_changed: {
                        id_of_the_device: power_device.device_id
                      },
                      temperature_changed: {
                        id_of_the_device: temperature_device.device_id
                      },
                      temperature_over_specified: {
                        id_of_the_device: temperature_device.device_id,
                        threshold_temperature: 10,
                      },
                      temperature_under_specified: {
                        id_of_the_device: temperature_device.device_id,
                        threshold_temperature: 90,
                      },
                      humidity_changed: {
                        id_of_the_device: humidity_device.device_id
                      },
                      motion_active: {
                        id_of_the_device: motion_device.device_id
                      },
                      motion_inactive: {
                        id_of_the_device: motion_device.device_id
                      },
                      illuminance_changed: {
                        id_of_the_device: illuminance_device.device_id
                      },
                      level_changed: {
                        id_of_the_device: level_device.device_id
                      },
                    },
                    actions: {
                      turn_switch_on : {
                        id_of_the_device: switch_device.device_id
                      },
                      turn_switch_off: {
                        id_of_the_device: switch_device.device_id
                      },
                      open_valve : {
                        id_of_the_device: valve_device.device_id
                      },
                      close_valve: {
                        id_of_the_device: valve_device.device_id
                      },
                      lock_lock: {
                        id_of_the_device: lock_device.device_id
                      },
                      unlock_lock: {
                        id_of_the_device: lock_device.device_id
                      },
                    },
                    actionRecordSkipping: {
                      create_new_thing: { invalid: "true" }
                    }
                  },
                }
            });
        })
    }).catch(err => {console.error(err);});
}

module.exports = testsetup;
