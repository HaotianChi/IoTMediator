const axios = require('axios').default;
const utility = require('../../core/utility');
const config = require('../../config/default');

// Takes in an array of trigger identities
// Sends POST request to IFTTT real time notification endpoint
const notify = (trigger_identities) => {

  // Debugging info
  // console.log("==================== NOTIFIYING IFTTT ======================");
  // console.log("Successfully Notified IFTTT Endpoint that a device has changed");
  // console.log("Trigger Identities send to IFTTT notification endpoint.");
  // console.log(trigger_identities);
  // console.log();
  // console.log();
  return axios.post('https://realtime.ifttt.com/v1/notifications', 
    {
      data: trigger_identities,
    }, 
    {
      headers: { 
        "IFTTT-Service-Key": config.ifttt.service_key,
        "X-Request-ID": utility.generateUniqueId()
      }
    })
    .then(function (response) {
      // console.log(response);
    })
    .catch(function (error) {
      console.log(error);
    });
}

module.exports = notify;
