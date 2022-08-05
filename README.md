# shm-lru-cache

A cache object that deletes the least-recently-used items.

[![Coverage Status](https://coveralls.io/repos/copious.world/shm-lru-cache/badge.svg?service=github)](https://coveralls.io/github/copious-world/shm-lru-cache)

## Installation:

```javascript
npm install shm-lru-cache --save
```

## Usage:

```javascript

In general a cache will be created for some object using it.

Here is one that creates a section of memory for the LRU:

this.cache = new LRU({
    "token_path" : "./ml_relay.conf",
    "am_initializer" : true,
    "seed" : 95982749,
    "record_size" : 384,
    "el_count" : 20000,
    "stop_child" : true
})

Here is one that attaches to a section that has already been created:

this.cache = new LRU({
    "token_path" : "./ml_relay.conf",
    "am_initializer" : false,
    "seed" : 95982749,		// same seed
    "record_size" : 384,	// same
    "el_count" : 20000,		// same
    "stop_child" : true
})


```


In the following a library is making use of the created cache:

```
    // ----
    check_hash(hh_unid,value) {
      let sdata = ( typeof value !== 'string' ) ? JSON.stringify(value) : value
      let hh_unidentified = this.cache.hasher(sdata)
      return hh_unidentified === hh_unid
    }
    
    // ----
    delete(key) { // token must have been returned by set () -> augmented_hash_token
      let augmented_hash_token = this.cache.hash(key)
      this.cache.del(augmented_hash_token)
    }

    // ----
    async get(key) {    // token must have been returned by set () -> augmented_hash_token
      let augmented_hash_token = this.cache.hash(key)
      let value = await this.cache.get(augmented_hash_token)
      if ( typeof value !== 'string' ) {
        return false
      }
      return value
    }

    // ----
    async get_with_token(token) {
        let value = await this.cache.get(token)
        if ( typeof value !== 'string' ) {
          return false
        }
        return value  
    }

    // ----
    run_evictions(time_shift,reduced_max) {  // one process will run this 
      let evict_list = this.cache.immediate_mapped_evictions(time_shift,reduced_max)
      return evict_list
    }
    
    //  ...

    // ----
    disconnect(opt) {
      if ( this.ev_interval ) {
        clearInterval(this.ev_interval)
        this.ev_interval = false
      }
      this.in_operation = false
      return this.cache.disconnect(opt)
    }
```


## Options

* `am_initializer`  : whether or not this is a creator.
* `max_evictions` : 
* `el_count`		: number of elements that will be stored in the cache
* `token_path` : a path to an actual file on disk. The path name is used to create a token for the memory region.
* `record_size` : the size of an element
* `seed` : this is the seed for the hash function.
* `sessions_length` : 
* `aged_out_secs` : 
* 


## API

* `hash(value)`  : returns an augmented hash, includes and index,hyphen,pure hash
* `pure_hash(value)`	: returns a hash of the value returned by the default hasher (which may be an xxhash)
* `augment_hash(hash)` : given a pure hash, return the augmented version

* `async set(hash_augmented,value)`  : put the value into the LRU
* `async get(hash_augmented) => value` : retrieve the value

    Both of these will update the "recently used"-ness of the key.
    They do what you think.

    If the key is not found, `get()` will return `false`.

    The key and val can be any value.

* `async del(hash_augmented)` also `async delete(hash_augmented)`

    Deletes a key out of the cache.

The following methods have to do with removing old keys from the LRU:

* `immediate_evictions(age_reduction,e_max)`  : Returns an array of keys that were removed. 

For the next two, the map of pure hashes to values can be passed upstream to other LRUs. These methods return the map. 

* `immediate_mapped_evictions(age_reduction,e_max)` : Returns a map of keys to values

* `immediate_targeted_evictions(hash_augmented,age_reduction,e_max)`  Returns a map of keys to values. The evictions are mostly from the bucket related to the hash parameter.


* `disconnect(opt)` : Cleans up the library assets when shutting down. 

* `app_handle_evicted(evict_list)` : If a descendant is written, this will be passed a list of hashes. Use by immediate\_evictions.


