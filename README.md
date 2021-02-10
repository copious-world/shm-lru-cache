# shm-lru-cache

A cache object that deletes the least-recently-used items.

[![Build Status](https://travis-ci.org/copious.world/shm-lru-cache.svg?branch=master)](https://travis-ci.org/copious.world/shm-lru-cache) [![Coverage Status](https://coveralls.io/repos/copious.world/shm-lru-cache/badge.svg?service=github)](https://coveralls.io/github/copious.world/shm-lru-cache)

## Installation:

```javascript
npm install shm-lru-cache --save
```

## Usage:

```javascript
// node.js exposition
```



## Options

* `max` The maximum size of the cache, checked by applying the length
  function to all values in the cache.  Not setting this is kind of
  silly, since that's the whole purpose of this lib, but it defaults
  to `Infinity`.
* `maxAge` Maximum age in ms.  Items are not pro-actively pruned out
  as they age, but if you try to get an item that is too old, it'll
  drop it and return undefined instead of giving it to you.
* `record_size` 


## API

* `set(key, value, maxAge)`
* `get(key) => value`

    Both of these will update the "recently used"-ness of the key.
    They do what you think. `maxAge` is optional and overrides the
    cache `maxAge` option if provided.

    If the key is not found, `get()` will return `undefined`.

    The key and val can be any value.

* `peek(key)`

    Returns the key value (or `undefined` if not found) without
    updating the "recently used"-ness of the key.

    (If you find yourself using this a lot, you *might* be using the
    wrong sort of data structure, but there are some use cases where
    it's handy.)

* `del(key)`

    Deletes a key out of the cache.

* `reset()`

    Clear the cache entirely, throwing away all values.

* `has(key)`

    Check if a key is in the cache, without updating the recent-ness
    or deleting it for being stale.

* `keys()`

    Return an array of the keys in the cache.

* `values()`

    Return an array of the values in the cache.

* `length`

    Return total length of objects in cache taking into account
    `length` options function.

* `itemCount`

    Return total quantity of objects currently in cache. Note, that
    `stale` (see options) items are returned as part of this item
    count.

* `dump()`

    Return an array of the cache entries ready for serialization and usage
    with 'destinationCache.load(arr)`.

* `load(cacheEntriesArray)`

	this is a test

* `prune()`

    Manually iterates over the entire cache proactively pruning old entries
