

const LRU = require('../index')


var g_app_seed = 12234
var g_hasher32 = null

class LRUManager {
    //
    constructor(conf) {
      conf.module_path = 'captcha'
      if ( conf.module_path[conf.module_path-1] ==='/' ) conf.module_path = conf.module_path.substr(0,conf.module_path.length-1)
      conf.cache.module_path = conf.module_path
      this.cache = new LRU(conf.cache)
      this.in_operation = true
    }
  
    //
    set(key,value) {
      delete value.uuid
      let sdata = JSON.stringify(value)
      let augmented_hash_token = this.cache.hash(key)
      this.cache.set(augmented_hash_token, sdata)   // store in the LRU cache
      return(augmented_hash_token)    // return the derived key
    }
    
    //
    delete(token) { // token must have been returned by set () -> augmented_hash_token
      let augmented_hash_token = this.cache.hash(token)
      this.cache.del(augmented_hash_token)
    }
  
    //
    get(token) {    // token must have been returned by set () -> augmented_hash_token
      let augmented_hash_token = this.cache.hash(token)
      let value = this.cache.get(augmented_hash_token)
      //
      if ( typeof value !== 'string' ) {
        return false
      }
      //
      return value
    }
  
    //
    disconnect(opt) {
      this.in_operation = false
      return this.cache.disconnect(opt)
    }
  
}


function run_test() {

  let conf = 
  {
      "cache" : {
          "master_of_ceremonies" : "/Users/richardalbertleddy/Documents/GitHub/copious.world/src/copious-transitions/captcha",
          "seed" :  "23E5FA9017",
          "proc_names" : [ "captcha", "uploader" ],
          "record_size" : 150,
          "el_count" : 50000
      }
  }


  let lru_m = new LRUManager(conf)

  let emails = {
      "jj@pp.com" : {
          "sing" : "bing",
          "subject" : "poor little butter cup"
      },
      "bcup@dcup.com" : {
          "sing" : "oopsie",
          "subject" : "green little men"
      },
      "green@dude.com" : {
          "sing" : "woo-hoo",
          "subject" : "green little ladies"
      },
      "green@girl.com" : {
          "sing" : "boo-boo",
          "subject" : "little broken cups"
      }
  }

  for ( let email in emails ) {
      let value = emails[email]
      let hh = lru_m.set(email,value)
      console.log(`${hh}  ${email}`)
  }


  for ( let email in emails ) {
      let value = lru_m.get(email)
      console.log(`${email}  ${value}`)
  }


}


module.exports = run_test