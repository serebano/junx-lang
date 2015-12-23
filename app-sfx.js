(function(global) {

  var defined = {};

  // indexOf polyfill for IE8
  var indexOf = Array.prototype.indexOf || function(item) {
    for (var i = 0, l = this.length; i < l; i++)
      if (this[i] === item)
        return i;
    return -1;
  }

  function dedupe(deps) {
    var newDeps = [];
    for (var i = 0, l = deps.length; i < l; i++)
      if (indexOf.call(newDeps, deps[i]) == -1)
        newDeps.push(deps[i])
    return newDeps;
  }

  function register(name, deps, declare, execute) {
    if (typeof name != 'string')
      throw "System.register provided no module name";

    var entry;

    // dynamic
    if (typeof declare == 'boolean') {
      entry = {
        declarative: false,
        deps: deps,
        execute: execute,
        executingRequire: declare
      };
    }
    else {
      // ES6 declarative
      entry = {
        declarative: true,
        deps: deps,
        declare: declare
      };
    }

    entry.name = name;

    // we never overwrite an existing define
    if (!(name in defined))
      defined[name] = entry; 

    entry.deps = dedupe(entry.deps);

    // we have to normalize dependencies
    // (assume dependencies are normalized for now)
    // entry.normalizedDeps = entry.deps.map(normalize);
    entry.normalizedDeps = entry.deps;
  }

  function buildGroups(entry, groups) {
    groups[entry.groupIndex] = groups[entry.groupIndex] || [];

    if (indexOf.call(groups[entry.groupIndex], entry) != -1)
      return;

    groups[entry.groupIndex].push(entry);

    for (var i = 0, l = entry.normalizedDeps.length; i < l; i++) {
      var depName = entry.normalizedDeps[i];
      var depEntry = defined[depName];

      // not in the registry means already linked / ES6
      if (!depEntry || depEntry.evaluated)
        continue;

      // now we know the entry is in our unlinked linkage group
      var depGroupIndex = entry.groupIndex + (depEntry.declarative != entry.declarative);

      // the group index of an entry is always the maximum
      if (depEntry.groupIndex === undefined || depEntry.groupIndex < depGroupIndex) {

        // if already in a group, remove from the old group
        if (depEntry.groupIndex !== undefined) {
          groups[depEntry.groupIndex].splice(indexOf.call(groups[depEntry.groupIndex], depEntry), 1);

          // if the old group is empty, then we have a mixed depndency cycle
          if (groups[depEntry.groupIndex].length == 0)
            throw new TypeError("Mixed dependency cycle detected");
        }

        depEntry.groupIndex = depGroupIndex;
      }

      buildGroups(depEntry, groups);
    }
  }

  function link(name) {
    var startEntry = defined[name];

    startEntry.groupIndex = 0;

    var groups = [];

    buildGroups(startEntry, groups);

    var curGroupDeclarative = !!startEntry.declarative == groups.length % 2;
    for (var i = groups.length - 1; i >= 0; i--) {
      var group = groups[i];
      for (var j = 0; j < group.length; j++) {
        var entry = group[j];

        // link each group
        if (curGroupDeclarative)
          linkDeclarativeModule(entry);
        else
          linkDynamicModule(entry);
      }
      curGroupDeclarative = !curGroupDeclarative; 
    }
  }

  // module binding records
  var moduleRecords = {};
  function getOrCreateModuleRecord(name) {
    return moduleRecords[name] || (moduleRecords[name] = {
      name: name,
      dependencies: [],
      exports: {}, // start from an empty module and extend
      importers: []
    })
  }

  function linkDeclarativeModule(entry) {
    // only link if already not already started linking (stops at circular)
    if (entry.module)
      return;

    var module = entry.module = getOrCreateModuleRecord(entry.name);
    var exports = entry.module.exports;

    var declaration = entry.declare.call(global, function(name, value) {
      module.locked = true;
      exports[name] = value;

      for (var i = 0, l = module.importers.length; i < l; i++) {
        var importerModule = module.importers[i];
        if (!importerModule.locked) {
          var importerIndex = indexOf.call(importerModule.dependencies, module);
          importerModule.setters[importerIndex](exports);
        }
      }

      module.locked = false;
      return value;
    });

    module.setters = declaration.setters;
    module.execute = declaration.execute;

    if (!module.setters || !module.execute)
      throw new TypeError("Invalid System.register form for " + entry.name);

    // now link all the module dependencies
    for (var i = 0, l = entry.normalizedDeps.length; i < l; i++) {
      var depName = entry.normalizedDeps[i];
      var depEntry = defined[depName];
      var depModule = moduleRecords[depName];

      // work out how to set depExports based on scenarios...
      var depExports;

      if (depModule) {
        depExports = depModule.exports;
      }
      else if (depEntry && !depEntry.declarative) {
        if (depEntry.module.exports && depEntry.module.exports.__esModule)
          depExports = depEntry.module.exports;
        else
          depExports = { 'default': depEntry.module.exports, __useDefault: true };
      }
      // in the module registry
      else if (!depEntry) {
        depExports = load(depName);
      }
      // we have an entry -> link
      else {
        linkDeclarativeModule(depEntry);
        depModule = depEntry.module;
        depExports = depModule.exports;
      }

      // only declarative modules have dynamic bindings
      if (depModule && depModule.importers) {
        depModule.importers.push(module);
        module.dependencies.push(depModule);
      }
      else
        module.dependencies.push(null);

      // run the setter for this dependency
      if (module.setters[i])
        module.setters[i](depExports);
    }
  }

  // An analog to loader.get covering execution of all three layers (real declarative, simulated declarative, simulated dynamic)
  function getModule(name) {
    var exports;
    var entry = defined[name];

    if (!entry) {
      exports = load(name);
      if (!exports)
        throw new Error("Unable to load dependency " + name + ".");
    }

    else {
      if (entry.declarative)
        ensureEvaluated(name, []);

      else if (!entry.evaluated)
        linkDynamicModule(entry);

      exports = entry.module.exports;
    }

    if ((!entry || entry.declarative) && exports && exports.__useDefault)
      return exports['default'];

    return exports;
  }

  function linkDynamicModule(entry) {
    if (entry.module)
      return;

    var exports = {};

    var module = entry.module = { exports: exports, id: entry.name };

    // AMD requires execute the tree first
    if (!entry.executingRequire) {
      for (var i = 0, l = entry.normalizedDeps.length; i < l; i++) {
        var depName = entry.normalizedDeps[i];
        var depEntry = defined[depName];
        if (depEntry)
          linkDynamicModule(depEntry);
      }
    }

    // now execute
    entry.evaluated = true;
    var output = entry.execute.call(global, function(name) {
      for (var i = 0, l = entry.deps.length; i < l; i++) {
        if (entry.deps[i] != name)
          continue;
        return getModule(entry.normalizedDeps[i]);
      }
      throw new TypeError('Module ' + name + ' not declared as a dependency.');
    }, exports, module);

    if (output)
      module.exports = output;
  }

  /*
   * Given a module, and the list of modules for this current branch,
   *  ensure that each of the dependencies of this module is evaluated
   *  (unless one is a circular dependency already in the list of seen
   *  modules, in which case we execute it)
   *
   * Then we evaluate the module itself depth-first left to right 
   * execution to match ES6 modules
   */
  function ensureEvaluated(moduleName, seen) {
    var entry = defined[moduleName];

    // if already seen, that means it's an already-evaluated non circular dependency
    if (!entry || entry.evaluated || !entry.declarative)
      return;

    // this only applies to declarative modules which late-execute

    seen.push(moduleName);

    for (var i = 0, l = entry.normalizedDeps.length; i < l; i++) {
      var depName = entry.normalizedDeps[i];
      if (indexOf.call(seen, depName) == -1) {
        if (!defined[depName])
          load(depName);
        else
          ensureEvaluated(depName, seen);
      }
    }

    if (entry.evaluated)
      return;

    entry.evaluated = true;
    entry.module.execute.call(global);
  }

  // magical execution function
  var modules = {};
  function load(name) {
    if (modules[name])
      return modules[name];

    var entry = defined[name];

    // first we check if this module has already been defined in the registry
    if (!entry)
      throw "Module " + name + " not present.";

    // recursively ensure that the module and all its 
    // dependencies are linked (with dependency group handling)
    link(name);

    // now handle dependency execution in correct order
    ensureEvaluated(name, []);

    // remove from the registry
    defined[name] = undefined;

    var module = entry.module.exports;

    if (!module || !entry.declarative && module.__esModule !== true)
      module = { 'default': module, __useDefault: true };

    // return the defined module object
    return modules[name] = module;
  };

  return function(mains, declare) {

    var System;
    var System = {
      register: register, 
      get: load, 
      set: function(name, module) {
        modules[name] = module; 
      },
      newModule: function(module) {
        return module;
      },
      global: global 
    };
    System.set('@empty', {});

    declare(System);

    for (var i = 0; i < mains.length; i++)
      load(mains[i]);
  }

})(typeof window != 'undefined' ? window : global)
/* (['mainModule'], function(System) {
  System.register(...);
}); */

(['chat/app'], function(System) {

System.register("npm:core-js@0.9.18/library/modules/$.fw", [], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  module.exports = function($) {
    $.FW = false;
    $.path = $.core;
    return $;
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.18/library/modules/$.enum-keys", ["npm:core-js@0.9.18/library/modules/$"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var $ = require("npm:core-js@0.9.18/library/modules/$");
  module.exports = function(it) {
    var keys = $.getKeys(it),
        getDesc = $.getDesc,
        getSymbols = $.getSymbols;
    if (getSymbols)
      $.each.call(getSymbols(it), function(key) {
        if (getDesc(it, key).enumerable)
          keys.push(key);
      });
    return keys;
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.18/library/modules/$.string-at", ["npm:core-js@0.9.18/library/modules/$"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var $ = require("npm:core-js@0.9.18/library/modules/$");
  module.exports = function(TO_STRING) {
    return function(that, pos) {
      var s = String($.assertDefined(that)),
          i = $.toInteger(pos),
          l = s.length,
          a,
          b;
      if (i < 0 || i >= l)
        return TO_STRING ? '' : undefined;
      a = s.charCodeAt(i);
      return a < 0xd800 || a > 0xdbff || i + 1 === l || (b = s.charCodeAt(i + 1)) < 0xdc00 || b > 0xdfff ? TO_STRING ? s.charAt(i) : a : TO_STRING ? s.slice(i, i + 2) : (a - 0xd800 << 10) + (b - 0xdc00) + 0x10000;
    };
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.18/library/modules/$.uid", ["npm:core-js@0.9.18/library/modules/$"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var sid = 0;
  function uid(key) {
    return 'Symbol('.concat(key === undefined ? '' : key, ')_', (++sid + Math.random()).toString(36));
  }
  uid.safe = require("npm:core-js@0.9.18/library/modules/$").g.Symbol || uid;
  module.exports = uid;
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.18/library/modules/$.shared", ["npm:core-js@0.9.18/library/modules/$"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var $ = require("npm:core-js@0.9.18/library/modules/$"),
      SHARED = '__core-js_shared__',
      store = $.g[SHARED] || ($.g[SHARED] = {});
  module.exports = function(key) {
    return store[key] || (store[key] = {});
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.18/library/modules/$.assert", ["npm:core-js@0.9.18/library/modules/$"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var $ = require("npm:core-js@0.9.18/library/modules/$");
  function assert(condition, msg1, msg2) {
    if (!condition)
      throw TypeError(msg2 ? msg1 + msg2 : msg1);
  }
  assert.def = $.assertDefined;
  assert.fn = function(it) {
    if (!$.isFunction(it))
      throw TypeError(it + ' is not a function!');
    return it;
  };
  assert.obj = function(it) {
    if (!$.isObject(it))
      throw TypeError(it + ' is not an object!');
    return it;
  };
  assert.inst = function(it, Constructor, name) {
    if (!(it instanceof Constructor))
      throw TypeError(name + ": use the 'new' operator!");
    return it;
  };
  module.exports = assert;
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.18/library/modules/$.redef", ["npm:core-js@0.9.18/library/modules/$"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  module.exports = require("npm:core-js@0.9.18/library/modules/$").hide;
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.18/library/modules/$.ctx", ["npm:core-js@0.9.18/library/modules/$.assert"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var assertFunction = require("npm:core-js@0.9.18/library/modules/$.assert").fn;
  module.exports = function(fn, that, length) {
    assertFunction(fn);
    if (~length && that === undefined)
      return fn;
    switch (length) {
      case 1:
        return function(a) {
          return fn.call(that, a);
        };
      case 2:
        return function(a, b) {
          return fn.call(that, a, b);
        };
      case 3:
        return function(a, b, c) {
          return fn.call(that, a, b, c);
        };
    }
    return function() {
      return fn.apply(that, arguments);
    };
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.18/library/modules/$.iter-call", ["npm:core-js@0.9.18/library/modules/$.assert"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var assertObject = require("npm:core-js@0.9.18/library/modules/$.assert").obj;
  function close(iterator) {
    var ret = iterator['return'];
    if (ret !== undefined)
      assertObject(ret.call(iterator));
  }
  function call(iterator, fn, value, entries) {
    try {
      return entries ? fn(assertObject(value)[0], value[1]) : fn(value);
    } catch (e) {
      close(iterator);
      throw e;
    }
  }
  call.close = close;
  module.exports = call;
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.18/library/modules/$.iter-detect", ["npm:core-js@0.9.18/library/modules/$.wks"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var SYMBOL_ITERATOR = require("npm:core-js@0.9.18/library/modules/$.wks")('iterator'),
      SAFE_CLOSING = false;
  try {
    var riter = [7][SYMBOL_ITERATOR]();
    riter['return'] = function() {
      SAFE_CLOSING = true;
    };
    Array.from(riter, function() {
      throw 2;
    });
  } catch (e) {}
  module.exports = function(exec) {
    if (!SAFE_CLOSING)
      return false;
    var safe = false;
    try {
      var arr = [7],
          iter = arr[SYMBOL_ITERATOR]();
      iter.next = function() {
        safe = true;
      };
      arr[SYMBOL_ITERATOR] = function() {
        return iter;
      };
      exec(arr);
    } catch (e) {}
    return safe;
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.18/library/fn/object/define-property", ["npm:core-js@0.9.18/library/modules/$"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var $ = require("npm:core-js@0.9.18/library/modules/$");
  module.exports = function defineProperty(it, key, desc) {
    return $.setDesc(it, key, desc);
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:babel-runtime@5.8.34/helpers/slice", [], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  "use strict";
  exports["default"] = Array.prototype.slice;
  exports.__esModule = true;
  global.define = __define;
  return module.exports;
});

System.register("npm:babel-runtime@5.8.34/helpers/bind", [], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  "use strict";
  exports["default"] = Function.prototype.bind;
  exports.__esModule = true;
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.18/library/modules/es6.object.to-string", ["npm:core-js@0.9.18/library/modules/$.cof", "npm:core-js@0.9.18/library/modules/$.wks", "npm:core-js@0.9.18/library/modules/$", "npm:core-js@0.9.18/library/modules/$.redef"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var cof = require("npm:core-js@0.9.18/library/modules/$.cof"),
      tmp = {};
  tmp[require("npm:core-js@0.9.18/library/modules/$.wks")('toStringTag')] = 'z';
  if (require("npm:core-js@0.9.18/library/modules/$").FW && cof(tmp) != 'z') {
    require("npm:core-js@0.9.18/library/modules/$.redef")(Object.prototype, 'toString', function toString() {
      return '[object ' + cof.classof(this) + ']';
    }, true);
  }
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.18/library/modules/$.unscope", [], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  module.exports = function() {};
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.18/library/modules/$.for-of", ["npm:core-js@0.9.18/library/modules/$.ctx", "npm:core-js@0.9.18/library/modules/$.iter", "npm:core-js@0.9.18/library/modules/$.iter-call"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var ctx = require("npm:core-js@0.9.18/library/modules/$.ctx"),
      get = require("npm:core-js@0.9.18/library/modules/$.iter").get,
      call = require("npm:core-js@0.9.18/library/modules/$.iter-call");
  module.exports = function(iterable, entries, fn, that) {
    var iterator = get(iterable),
        f = ctx(fn, that, entries ? 2 : 1),
        step;
    while (!(step = iterator.next()).done) {
      if (call(iterator, f, step.value, entries) === false) {
        return call.close(iterator);
      }
    }
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.18/library/modules/$.mix", ["npm:core-js@0.9.18/library/modules/$.redef"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var $redef = require("npm:core-js@0.9.18/library/modules/$.redef");
  module.exports = function(target, src) {
    for (var key in src)
      $redef(target, key, src[key]);
    return target;
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.18/library/modules/$.species", ["npm:core-js@0.9.18/library/modules/$", "npm:core-js@0.9.18/library/modules/$.wks"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var $ = require("npm:core-js@0.9.18/library/modules/$"),
      SPECIES = require("npm:core-js@0.9.18/library/modules/$.wks")('species');
  module.exports = function(C) {
    if ($.DESC && !(SPECIES in C))
      $.setDesc(C, SPECIES, {
        configurable: true,
        get: $.that
      });
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.18/library/modules/$.collection-to-json", ["npm:core-js@0.9.18/library/modules/$.def", "npm:core-js@0.9.18/library/modules/$.for-of"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var $def = require("npm:core-js@0.9.18/library/modules/$.def"),
      forOf = require("npm:core-js@0.9.18/library/modules/$.for-of");
  module.exports = function(NAME) {
    $def($def.P, NAME, {toJSON: function toJSON() {
        var arr = [];
        forOf(this, false, arr.push, arr);
        return arr;
      }});
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.18/library/modules/$.array-methods", ["npm:core-js@0.9.18/library/modules/$", "npm:core-js@0.9.18/library/modules/$.ctx"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var $ = require("npm:core-js@0.9.18/library/modules/$"),
      ctx = require("npm:core-js@0.9.18/library/modules/$.ctx");
  module.exports = function(TYPE) {
    var IS_MAP = TYPE == 1,
        IS_FILTER = TYPE == 2,
        IS_SOME = TYPE == 3,
        IS_EVERY = TYPE == 4,
        IS_FIND_INDEX = TYPE == 6,
        NO_HOLES = TYPE == 5 || IS_FIND_INDEX;
    return function($this, callbackfn, that) {
      var O = Object($.assertDefined($this)),
          self = $.ES5Object(O),
          f = ctx(callbackfn, that, 3),
          length = $.toLength(self.length),
          index = 0,
          result = IS_MAP ? Array(length) : IS_FILTER ? [] : undefined,
          val,
          res;
      for (; length > index; index++)
        if (NO_HOLES || index in self) {
          val = self[index];
          res = f(val, index, O);
          if (TYPE) {
            if (IS_MAP)
              result[index] = res;
            else if (res)
              switch (TYPE) {
                case 3:
                  return true;
                case 5:
                  return val;
                case 6:
                  return index;
                case 2:
                  result.push(val);
              }
            else if (IS_EVERY)
              return false;
          }
        }
      return IS_FIND_INDEX ? -1 : IS_SOME || IS_EVERY ? IS_EVERY : result;
    };
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.18/library/modules/$.keyof", ["npm:core-js@0.9.18/library/modules/$"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var $ = require("npm:core-js@0.9.18/library/modules/$");
  module.exports = function(object, el) {
    var O = $.toObject(object),
        keys = $.getKeys(O),
        length = keys.length,
        index = 0,
        key;
    while (length > index)
      if (O[key = keys[index++]] === el)
        return key;
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.18/library/modules/$.get-names", ["npm:core-js@0.9.18/library/modules/$"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var $ = require("npm:core-js@0.9.18/library/modules/$"),
      toString = {}.toString,
      getNames = $.getNames;
  var windowNames = typeof window == 'object' && Object.getOwnPropertyNames ? Object.getOwnPropertyNames(window) : [];
  function getWindowNames(it) {
    try {
      return getNames(it);
    } catch (e) {
      return windowNames.slice();
    }
  }
  module.exports.get = function getOwnPropertyNames(it) {
    if (windowNames && toString.call(it) == '[object Window]')
      return getWindowNames(it);
    return getNames($.toObject(it));
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.18/library/fn/object/create", ["npm:core-js@0.9.18/library/modules/$"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var $ = require("npm:core-js@0.9.18/library/modules/$");
  module.exports = function create(P, D) {
    return $.create(P, D);
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.18/library/modules/$.set-proto", ["npm:core-js@0.9.18/library/modules/$", "npm:core-js@0.9.18/library/modules/$.assert", "npm:core-js@0.9.18/library/modules/$.ctx"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var $ = require("npm:core-js@0.9.18/library/modules/$"),
      assert = require("npm:core-js@0.9.18/library/modules/$.assert");
  function check(O, proto) {
    assert.obj(O);
    assert(proto === null || $.isObject(proto), proto, ": can't set as prototype!");
  }
  module.exports = {
    set: Object.setPrototypeOf || ('__proto__' in {} ? function(buggy, set) {
      try {
        set = require("npm:core-js@0.9.18/library/modules/$.ctx")(Function.call, $.getDesc(Object.prototype, '__proto__').set, 2);
        set({}, []);
      } catch (e) {
        buggy = true;
      }
      return function setPrototypeOf(O, proto) {
        check(O, proto);
        if (buggy)
          O.__proto__ = proto;
        else
          set(O, proto);
        return O;
      };
    }() : undefined),
    check: check
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.18/library/modules/$.same", [], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  module.exports = Object.is || function is(x, y) {
    return x === y ? x !== 0 || 1 / x === 1 / y : x != x && y != y;
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.18/library/modules/$.invoke", [], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  module.exports = function(fn, args, that) {
    var un = that === undefined;
    switch (args.length) {
      case 0:
        return un ? fn() : fn.call(that);
      case 1:
        return un ? fn(args[0]) : fn.call(that, args[0]);
      case 2:
        return un ? fn(args[0], args[1]) : fn.call(that, args[0], args[1]);
      case 3:
        return un ? fn(args[0], args[1], args[2]) : fn.call(that, args[0], args[1], args[2]);
      case 4:
        return un ? fn(args[0], args[1], args[2], args[3]) : fn.call(that, args[0], args[1], args[2], args[3]);
      case 5:
        return un ? fn(args[0], args[1], args[2], args[3], args[4]) : fn.call(that, args[0], args[1], args[2], args[3], args[4]);
    }
    return fn.apply(that, args);
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.18/library/modules/$.dom-create", ["npm:core-js@0.9.18/library/modules/$"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var $ = require("npm:core-js@0.9.18/library/modules/$"),
      document = $.g.document,
      isObject = $.isObject,
      is = isObject(document) && isObject(document.createElement);
  module.exports = function(it) {
    return is ? document.createElement(it) : {};
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:process@0.11.2/browser", [], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var process = module.exports = {};
  var queue = [];
  var draining = false;
  var currentQueue;
  var queueIndex = -1;
  function cleanUpNextTick() {
    draining = false;
    if (currentQueue.length) {
      queue = currentQueue.concat(queue);
    } else {
      queueIndex = -1;
    }
    if (queue.length) {
      drainQueue();
    }
  }
  function drainQueue() {
    if (draining) {
      return ;
    }
    var timeout = setTimeout(cleanUpNextTick);
    draining = true;
    var len = queue.length;
    while (len) {
      currentQueue = queue;
      queue = [];
      while (++queueIndex < len) {
        if (currentQueue) {
          currentQueue[queueIndex].run();
        }
      }
      queueIndex = -1;
      len = queue.length;
    }
    currentQueue = null;
    draining = false;
    clearTimeout(timeout);
  }
  process.nextTick = function(fun) {
    var args = new Array(arguments.length - 1);
    if (arguments.length > 1) {
      for (var i = 1; i < arguments.length; i++) {
        args[i - 1] = arguments[i];
      }
    }
    queue.push(new Item(fun, args));
    if (queue.length === 1 && !draining) {
      setTimeout(drainQueue, 0);
    }
  };
  function Item(fun, array) {
    this.fun = fun;
    this.array = array;
  }
  Item.prototype.run = function() {
    this.fun.apply(null, this.array);
  };
  process.title = 'browser';
  process.browser = true;
  process.env = {};
  process.argv = [];
  process.version = '';
  process.versions = {};
  function noop() {}
  process.on = noop;
  process.addListener = noop;
  process.once = noop;
  process.off = noop;
  process.removeListener = noop;
  process.removeAllListeners = noop;
  process.emit = noop;
  process.binding = function(name) {
    throw new Error('process.binding is not supported');
  };
  process.cwd = function() {
    return '/';
  };
  process.chdir = function(dir) {
    throw new Error('process.chdir is not supported');
  };
  process.umask = function() {
    return 0;
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.18/library/modules/es6.object.statics-accept-primitives", ["npm:core-js@0.9.18/library/modules/$", "npm:core-js@0.9.18/library/modules/$.def", "npm:core-js@0.9.18/library/modules/$.get-names"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var $ = require("npm:core-js@0.9.18/library/modules/$"),
      $def = require("npm:core-js@0.9.18/library/modules/$.def"),
      isObject = $.isObject,
      toObject = $.toObject;
  $.each.call(('freeze,seal,preventExtensions,isFrozen,isSealed,isExtensible,' + 'getOwnPropertyDescriptor,getPrototypeOf,keys,getOwnPropertyNames').split(','), function(KEY, ID) {
    var fn = ($.core.Object || {})[KEY] || Object[KEY],
        forced = 0,
        method = {};
    method[KEY] = ID == 0 ? function freeze(it) {
      return isObject(it) ? fn(it) : it;
    } : ID == 1 ? function seal(it) {
      return isObject(it) ? fn(it) : it;
    } : ID == 2 ? function preventExtensions(it) {
      return isObject(it) ? fn(it) : it;
    } : ID == 3 ? function isFrozen(it) {
      return isObject(it) ? fn(it) : true;
    } : ID == 4 ? function isSealed(it) {
      return isObject(it) ? fn(it) : true;
    } : ID == 5 ? function isExtensible(it) {
      return isObject(it) ? fn(it) : false;
    } : ID == 6 ? function getOwnPropertyDescriptor(it, key) {
      return fn(toObject(it), key);
    } : ID == 7 ? function getPrototypeOf(it) {
      return fn(Object($.assertDefined(it)));
    } : ID == 8 ? function keys(it) {
      return fn(toObject(it));
    } : require("npm:core-js@0.9.18/library/modules/$.get-names").get;
    try {
      fn('z');
    } catch (e) {
      forced = 1;
    }
    $def($def.S + $def.F * forced, 'Object', method);
  });
  global.define = __define;
  return module.exports;
});

System.register("npm:babel-runtime@5.8.34/helpers/create-class", ["npm:babel-runtime@5.8.34/core-js/object/define-property"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  "use strict";
  var _Object$defineProperty = require("npm:babel-runtime@5.8.34/core-js/object/define-property")["default"];
  exports["default"] = (function() {
    function defineProperties(target, props) {
      for (var i = 0; i < props.length; i++) {
        var descriptor = props[i];
        descriptor.enumerable = descriptor.enumerable || false;
        descriptor.configurable = true;
        if ("value" in descriptor)
          descriptor.writable = true;
        _Object$defineProperty(target, descriptor.key, descriptor);
      }
    }
    return function(Constructor, protoProps, staticProps) {
      if (protoProps)
        defineProperties(Constructor.prototype, protoProps);
      if (staticProps)
        defineProperties(Constructor, staticProps);
      return Constructor;
    };
  })();
  exports.__esModule = true;
  global.define = __define;
  return module.exports;
});

System.register("npm:babel-runtime@5.8.34/helpers/class-call-check", [], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  "use strict";
  exports["default"] = function(instance, Constructor) {
    if (!(instance instanceof Constructor)) {
      throw new TypeError("Cannot call a class as a function");
    }
  };
  exports.__esModule = true;
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.18/library/fn/object/keys", ["npm:core-js@0.9.18/library/modules/es6.object.statics-accept-primitives", "npm:core-js@0.9.18/library/modules/$"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  require("npm:core-js@0.9.18/library/modules/es6.object.statics-accept-primitives");
  module.exports = require("npm:core-js@0.9.18/library/modules/$").core.Object.keys;
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.18/library/modules/core.iter-helpers", ["npm:core-js@0.9.18/library/modules/$", "npm:core-js@0.9.18/library/modules/$.iter"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var core = require("npm:core-js@0.9.18/library/modules/$").core,
      $iter = require("npm:core-js@0.9.18/library/modules/$.iter");
  core.isIterable = $iter.is;
  core.getIterator = $iter.get;
  global.define = __define;
  return module.exports;
});

System.register("npm:js-beautify@1.5.10/js/lib/beautify", [], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  "format cjs";
  (function() {
    var acorn = {};
    (function(exports) {
      var nonASCIIwhitespace = /[\u1680\u180e\u2000-\u200a\u202f\u205f\u3000\ufeff]/;
      var nonASCIIidentifierStartChars = "\xaa\xb5\xba\xc0-\xd6\xd8-\xf6\xf8-\u02c1\u02c6-\u02d1\u02e0-\u02e4\u02ec\u02ee\u0370-\u0374\u0376\u0377\u037a-\u037d\u0386\u0388-\u038a\u038c\u038e-\u03a1\u03a3-\u03f5\u03f7-\u0481\u048a-\u0527\u0531-\u0556\u0559\u0561-\u0587\u05d0-\u05ea\u05f0-\u05f2\u0620-\u064a\u066e\u066f\u0671-\u06d3\u06d5\u06e5\u06e6\u06ee\u06ef\u06fa-\u06fc\u06ff\u0710\u0712-\u072f\u074d-\u07a5\u07b1\u07ca-\u07ea\u07f4\u07f5\u07fa\u0800-\u0815\u081a\u0824\u0828\u0840-\u0858\u08a0\u08a2-\u08ac\u0904-\u0939\u093d\u0950\u0958-\u0961\u0971-\u0977\u0979-\u097f\u0985-\u098c\u098f\u0990\u0993-\u09a8\u09aa-\u09b0\u09b2\u09b6-\u09b9\u09bd\u09ce\u09dc\u09dd\u09df-\u09e1\u09f0\u09f1\u0a05-\u0a0a\u0a0f\u0a10\u0a13-\u0a28\u0a2a-\u0a30\u0a32\u0a33\u0a35\u0a36\u0a38\u0a39\u0a59-\u0a5c\u0a5e\u0a72-\u0a74\u0a85-\u0a8d\u0a8f-\u0a91\u0a93-\u0aa8\u0aaa-\u0ab0\u0ab2\u0ab3\u0ab5-\u0ab9\u0abd\u0ad0\u0ae0\u0ae1\u0b05-\u0b0c\u0b0f\u0b10\u0b13-\u0b28\u0b2a-\u0b30\u0b32\u0b33\u0b35-\u0b39\u0b3d\u0b5c\u0b5d\u0b5f-\u0b61\u0b71\u0b83\u0b85-\u0b8a\u0b8e-\u0b90\u0b92-\u0b95\u0b99\u0b9a\u0b9c\u0b9e\u0b9f\u0ba3\u0ba4\u0ba8-\u0baa\u0bae-\u0bb9\u0bd0\u0c05-\u0c0c\u0c0e-\u0c10\u0c12-\u0c28\u0c2a-\u0c33\u0c35-\u0c39\u0c3d\u0c58\u0c59\u0c60\u0c61\u0c85-\u0c8c\u0c8e-\u0c90\u0c92-\u0ca8\u0caa-\u0cb3\u0cb5-\u0cb9\u0cbd\u0cde\u0ce0\u0ce1\u0cf1\u0cf2\u0d05-\u0d0c\u0d0e-\u0d10\u0d12-\u0d3a\u0d3d\u0d4e\u0d60\u0d61\u0d7a-\u0d7f\u0d85-\u0d96\u0d9a-\u0db1\u0db3-\u0dbb\u0dbd\u0dc0-\u0dc6\u0e01-\u0e30\u0e32\u0e33\u0e40-\u0e46\u0e81\u0e82\u0e84\u0e87\u0e88\u0e8a\u0e8d\u0e94-\u0e97\u0e99-\u0e9f\u0ea1-\u0ea3\u0ea5\u0ea7\u0eaa\u0eab\u0ead-\u0eb0\u0eb2\u0eb3\u0ebd\u0ec0-\u0ec4\u0ec6\u0edc-\u0edf\u0f00\u0f40-\u0f47\u0f49-\u0f6c\u0f88-\u0f8c\u1000-\u102a\u103f\u1050-\u1055\u105a-\u105d\u1061\u1065\u1066\u106e-\u1070\u1075-\u1081\u108e\u10a0-\u10c5\u10c7\u10cd\u10d0-\u10fa\u10fc-\u1248\u124a-\u124d\u1250-\u1256\u1258\u125a-\u125d\u1260-\u1288\u128a-\u128d\u1290-\u12b0\u12b2-\u12b5\u12b8-\u12be\u12c0\u12c2-\u12c5\u12c8-\u12d6\u12d8-\u1310\u1312-\u1315\u1318-\u135a\u1380-\u138f\u13a0-\u13f4\u1401-\u166c\u166f-\u167f\u1681-\u169a\u16a0-\u16ea\u16ee-\u16f0\u1700-\u170c\u170e-\u1711\u1720-\u1731\u1740-\u1751\u1760-\u176c\u176e-\u1770\u1780-\u17b3\u17d7\u17dc\u1820-\u1877\u1880-\u18a8\u18aa\u18b0-\u18f5\u1900-\u191c\u1950-\u196d\u1970-\u1974\u1980-\u19ab\u19c1-\u19c7\u1a00-\u1a16\u1a20-\u1a54\u1aa7\u1b05-\u1b33\u1b45-\u1b4b\u1b83-\u1ba0\u1bae\u1baf\u1bba-\u1be5\u1c00-\u1c23\u1c4d-\u1c4f\u1c5a-\u1c7d\u1ce9-\u1cec\u1cee-\u1cf1\u1cf5\u1cf6\u1d00-\u1dbf\u1e00-\u1f15\u1f18-\u1f1d\u1f20-\u1f45\u1f48-\u1f4d\u1f50-\u1f57\u1f59\u1f5b\u1f5d\u1f5f-\u1f7d\u1f80-\u1fb4\u1fb6-\u1fbc\u1fbe\u1fc2-\u1fc4\u1fc6-\u1fcc\u1fd0-\u1fd3\u1fd6-\u1fdb\u1fe0-\u1fec\u1ff2-\u1ff4\u1ff6-\u1ffc\u2071\u207f\u2090-\u209c\u2102\u2107\u210a-\u2113\u2115\u2119-\u211d\u2124\u2126\u2128\u212a-\u212d\u212f-\u2139\u213c-\u213f\u2145-\u2149\u214e\u2160-\u2188\u2c00-\u2c2e\u2c30-\u2c5e\u2c60-\u2ce4\u2ceb-\u2cee\u2cf2\u2cf3\u2d00-\u2d25\u2d27\u2d2d\u2d30-\u2d67\u2d6f\u2d80-\u2d96\u2da0-\u2da6\u2da8-\u2dae\u2db0-\u2db6\u2db8-\u2dbe\u2dc0-\u2dc6\u2dc8-\u2dce\u2dd0-\u2dd6\u2dd8-\u2dde\u2e2f\u3005-\u3007\u3021-\u3029\u3031-\u3035\u3038-\u303c\u3041-\u3096\u309d-\u309f\u30a1-\u30fa\u30fc-\u30ff\u3105-\u312d\u3131-\u318e\u31a0-\u31ba\u31f0-\u31ff\u3400-\u4db5\u4e00-\u9fcc\ua000-\ua48c\ua4d0-\ua4fd\ua500-\ua60c\ua610-\ua61f\ua62a\ua62b\ua640-\ua66e\ua67f-\ua697\ua6a0-\ua6ef\ua717-\ua71f\ua722-\ua788\ua78b-\ua78e\ua790-\ua793\ua7a0-\ua7aa\ua7f8-\ua801\ua803-\ua805\ua807-\ua80a\ua80c-\ua822\ua840-\ua873\ua882-\ua8b3\ua8f2-\ua8f7\ua8fb\ua90a-\ua925\ua930-\ua946\ua960-\ua97c\ua984-\ua9b2\ua9cf\uaa00-\uaa28\uaa40-\uaa42\uaa44-\uaa4b\uaa60-\uaa76\uaa7a\uaa80-\uaaaf\uaab1\uaab5\uaab6\uaab9-\uaabd\uaac0\uaac2\uaadb-\uaadd\uaae0-\uaaea\uaaf2-\uaaf4\uab01-\uab06\uab09-\uab0e\uab11-\uab16\uab20-\uab26\uab28-\uab2e\uabc0-\uabe2\uac00-\ud7a3\ud7b0-\ud7c6\ud7cb-\ud7fb\uf900-\ufa6d\ufa70-\ufad9\ufb00-\ufb06\ufb13-\ufb17\ufb1d\ufb1f-\ufb28\ufb2a-\ufb36\ufb38-\ufb3c\ufb3e\ufb40\ufb41\ufb43\ufb44\ufb46-\ufbb1\ufbd3-\ufd3d\ufd50-\ufd8f\ufd92-\ufdc7\ufdf0-\ufdfb\ufe70-\ufe74\ufe76-\ufefc\uff21-\uff3a\uff41-\uff5a\uff66-\uffbe\uffc2-\uffc7\uffca-\uffcf\uffd2-\uffd7\uffda-\uffdc";
      var nonASCIIidentifierChars = "\u0300-\u036f\u0483-\u0487\u0591-\u05bd\u05bf\u05c1\u05c2\u05c4\u05c5\u05c7\u0610-\u061a\u0620-\u0649\u0672-\u06d3\u06e7-\u06e8\u06fb-\u06fc\u0730-\u074a\u0800-\u0814\u081b-\u0823\u0825-\u0827\u0829-\u082d\u0840-\u0857\u08e4-\u08fe\u0900-\u0903\u093a-\u093c\u093e-\u094f\u0951-\u0957\u0962-\u0963\u0966-\u096f\u0981-\u0983\u09bc\u09be-\u09c4\u09c7\u09c8\u09d7\u09df-\u09e0\u0a01-\u0a03\u0a3c\u0a3e-\u0a42\u0a47\u0a48\u0a4b-\u0a4d\u0a51\u0a66-\u0a71\u0a75\u0a81-\u0a83\u0abc\u0abe-\u0ac5\u0ac7-\u0ac9\u0acb-\u0acd\u0ae2-\u0ae3\u0ae6-\u0aef\u0b01-\u0b03\u0b3c\u0b3e-\u0b44\u0b47\u0b48\u0b4b-\u0b4d\u0b56\u0b57\u0b5f-\u0b60\u0b66-\u0b6f\u0b82\u0bbe-\u0bc2\u0bc6-\u0bc8\u0bca-\u0bcd\u0bd7\u0be6-\u0bef\u0c01-\u0c03\u0c46-\u0c48\u0c4a-\u0c4d\u0c55\u0c56\u0c62-\u0c63\u0c66-\u0c6f\u0c82\u0c83\u0cbc\u0cbe-\u0cc4\u0cc6-\u0cc8\u0cca-\u0ccd\u0cd5\u0cd6\u0ce2-\u0ce3\u0ce6-\u0cef\u0d02\u0d03\u0d46-\u0d48\u0d57\u0d62-\u0d63\u0d66-\u0d6f\u0d82\u0d83\u0dca\u0dcf-\u0dd4\u0dd6\u0dd8-\u0ddf\u0df2\u0df3\u0e34-\u0e3a\u0e40-\u0e45\u0e50-\u0e59\u0eb4-\u0eb9\u0ec8-\u0ecd\u0ed0-\u0ed9\u0f18\u0f19\u0f20-\u0f29\u0f35\u0f37\u0f39\u0f41-\u0f47\u0f71-\u0f84\u0f86-\u0f87\u0f8d-\u0f97\u0f99-\u0fbc\u0fc6\u1000-\u1029\u1040-\u1049\u1067-\u106d\u1071-\u1074\u1082-\u108d\u108f-\u109d\u135d-\u135f\u170e-\u1710\u1720-\u1730\u1740-\u1750\u1772\u1773\u1780-\u17b2\u17dd\u17e0-\u17e9\u180b-\u180d\u1810-\u1819\u1920-\u192b\u1930-\u193b\u1951-\u196d\u19b0-\u19c0\u19c8-\u19c9\u19d0-\u19d9\u1a00-\u1a15\u1a20-\u1a53\u1a60-\u1a7c\u1a7f-\u1a89\u1a90-\u1a99\u1b46-\u1b4b\u1b50-\u1b59\u1b6b-\u1b73\u1bb0-\u1bb9\u1be6-\u1bf3\u1c00-\u1c22\u1c40-\u1c49\u1c5b-\u1c7d\u1cd0-\u1cd2\u1d00-\u1dbe\u1e01-\u1f15\u200c\u200d\u203f\u2040\u2054\u20d0-\u20dc\u20e1\u20e5-\u20f0\u2d81-\u2d96\u2de0-\u2dff\u3021-\u3028\u3099\u309a\ua640-\ua66d\ua674-\ua67d\ua69f\ua6f0-\ua6f1\ua7f8-\ua800\ua806\ua80b\ua823-\ua827\ua880-\ua881\ua8b4-\ua8c4\ua8d0-\ua8d9\ua8f3-\ua8f7\ua900-\ua909\ua926-\ua92d\ua930-\ua945\ua980-\ua983\ua9b3-\ua9c0\uaa00-\uaa27\uaa40-\uaa41\uaa4c-\uaa4d\uaa50-\uaa59\uaa7b\uaae0-\uaae9\uaaf2-\uaaf3\uabc0-\uabe1\uabec\uabed\uabf0-\uabf9\ufb20-\ufb28\ufe00-\ufe0f\ufe20-\ufe26\ufe33\ufe34\ufe4d-\ufe4f\uff10-\uff19\uff3f";
      var nonASCIIidentifierStart = new RegExp("[" + nonASCIIidentifierStartChars + "]");
      var nonASCIIidentifier = new RegExp("[" + nonASCIIidentifierStartChars + nonASCIIidentifierChars + "]");
      var newline = exports.newline = /[\n\r\u2028\u2029]/;
      var lineBreak = exports.lineBreak = /\r\n|[\n\r\u2028\u2029]/g;
      var isIdentifierStart = exports.isIdentifierStart = function(code) {
        if (code < 65)
          return code === 36;
        if (code < 91)
          return true;
        if (code < 97)
          return code === 95;
        if (code < 123)
          return true;
        return code >= 0xaa && nonASCIIidentifierStart.test(String.fromCharCode(code));
      };
      var isIdentifierChar = exports.isIdentifierChar = function(code) {
        if (code < 48)
          return code === 36;
        if (code < 58)
          return true;
        if (code < 65)
          return false;
        if (code < 91)
          return true;
        if (code < 97)
          return code === 95;
        if (code < 123)
          return true;
        return code >= 0xaa && nonASCIIidentifier.test(String.fromCharCode(code));
      };
    })(acorn);
    function in_array(what, arr) {
      for (var i = 0; i < arr.length; i += 1) {
        if (arr[i] === what) {
          return true;
        }
      }
      return false;
    }
    function trim(s) {
      return s.replace(/^\s+|\s+$/g, '');
    }
    function ltrim(s) {
      return s.replace(/^\s+/g, '');
    }
    function rtrim(s) {
      return s.replace(/\s+$/g, '');
    }
    function js_beautify(js_source_text, options) {
      "use strict";
      var beautifier = new Beautifier(js_source_text, options);
      return beautifier.beautify();
    }
    var MODE = {
      BlockStatement: 'BlockStatement',
      Statement: 'Statement',
      ObjectLiteral: 'ObjectLiteral',
      ArrayLiteral: 'ArrayLiteral',
      ForInitializer: 'ForInitializer',
      Conditional: 'Conditional',
      Expression: 'Expression'
    };
    function Beautifier(js_source_text, options) {
      "use strict";
      var output;
      var tokens = [],
          token_pos;
      var Tokenizer;
      var current_token;
      var last_type,
          last_last_text,
          indent_string;
      var flags,
          previous_flags,
          flag_store;
      var prefix;
      var handlers,
          opt;
      var baseIndentString = '';
      handlers = {
        'TK_START_EXPR': handle_start_expr,
        'TK_END_EXPR': handle_end_expr,
        'TK_START_BLOCK': handle_start_block,
        'TK_END_BLOCK': handle_end_block,
        'TK_WORD': handle_word,
        'TK_RESERVED': handle_word,
        'TK_SEMICOLON': handle_semicolon,
        'TK_STRING': handle_string,
        'TK_EQUALS': handle_equals,
        'TK_OPERATOR': handle_operator,
        'TK_COMMA': handle_comma,
        'TK_BLOCK_COMMENT': handle_block_comment,
        'TK_COMMENT': handle_comment,
        'TK_DOT': handle_dot,
        'TK_UNKNOWN': handle_unknown,
        'TK_EOF': handle_eof
      };
      function create_flags(flags_base, mode) {
        var next_indent_level = 0;
        if (flags_base) {
          next_indent_level = flags_base.indentation_level;
          if (!output.just_added_newline() && flags_base.line_indent_level > next_indent_level) {
            next_indent_level = flags_base.line_indent_level;
          }
        }
        var next_flags = {
          mode: mode,
          parent: flags_base,
          last_text: flags_base ? flags_base.last_text : '',
          last_word: flags_base ? flags_base.last_word : '',
          declaration_statement: false,
          declaration_assignment: false,
          multiline_frame: false,
          if_block: false,
          else_block: false,
          do_block: false,
          do_while: false,
          in_case_statement: false,
          in_case: false,
          case_body: false,
          indentation_level: next_indent_level,
          line_indent_level: flags_base ? flags_base.line_indent_level : next_indent_level,
          start_line_index: output.get_line_number(),
          ternary_depth: 0
        };
        return next_flags;
      }
      options = options ? options : {};
      opt = {};
      if (options.braces_on_own_line !== undefined) {
        opt.brace_style = options.braces_on_own_line ? "expand" : "collapse";
      }
      opt.brace_style = options.brace_style ? options.brace_style : (opt.brace_style ? opt.brace_style : "collapse");
      if (opt.brace_style === "expand-strict") {
        opt.brace_style = "expand";
      }
      opt.indent_size = options.indent_size ? parseInt(options.indent_size, 10) : 4;
      opt.indent_char = options.indent_char ? options.indent_char : ' ';
      opt.eol = options.eol ? options.eol : '\n';
      opt.preserve_newlines = (options.preserve_newlines === undefined) ? true : options.preserve_newlines;
      opt.break_chained_methods = (options.break_chained_methods === undefined) ? false : options.break_chained_methods;
      opt.max_preserve_newlines = (options.max_preserve_newlines === undefined) ? 0 : parseInt(options.max_preserve_newlines, 10);
      opt.space_in_paren = (options.space_in_paren === undefined) ? false : options.space_in_paren;
      opt.space_in_empty_paren = (options.space_in_empty_paren === undefined) ? false : options.space_in_empty_paren;
      opt.jslint_happy = (options.jslint_happy === undefined) ? false : options.jslint_happy;
      opt.space_after_anon_function = (options.space_after_anon_function === undefined) ? false : options.space_after_anon_function;
      opt.keep_array_indentation = (options.keep_array_indentation === undefined) ? false : options.keep_array_indentation;
      opt.space_before_conditional = (options.space_before_conditional === undefined) ? true : options.space_before_conditional;
      opt.unescape_strings = (options.unescape_strings === undefined) ? false : options.unescape_strings;
      opt.wrap_line_length = (options.wrap_line_length === undefined) ? 0 : parseInt(options.wrap_line_length, 10);
      opt.e4x = (options.e4x === undefined) ? false : options.e4x;
      opt.end_with_newline = (options.end_with_newline === undefined) ? false : options.end_with_newline;
      opt.comma_first = (options.comma_first === undefined) ? false : options.comma_first;
      opt.test_output_raw = (options.test_output_raw === undefined) ? false : options.test_output_raw;
      if (opt.jslint_happy) {
        opt.space_after_anon_function = true;
      }
      if (options.indent_with_tabs) {
        opt.indent_char = '\t';
        opt.indent_size = 1;
      }
      opt.eol = opt.eol.replace(/\\r/, '\r').replace(/\\n/, '\n');
      indent_string = '';
      while (opt.indent_size > 0) {
        indent_string += opt.indent_char;
        opt.indent_size -= 1;
      }
      var preindent_index = 0;
      if (js_source_text && js_source_text.length) {
        while ((js_source_text.charAt(preindent_index) === ' ' || js_source_text.charAt(preindent_index) === '\t')) {
          baseIndentString += js_source_text.charAt(preindent_index);
          preindent_index += 1;
        }
        js_source_text = js_source_text.substring(preindent_index);
      }
      last_type = 'TK_START_BLOCK';
      last_last_text = '';
      output = new Output(indent_string, baseIndentString);
      output.raw = opt.test_output_raw;
      flag_store = [];
      set_mode(MODE.BlockStatement);
      this.beautify = function() {
        var local_token,
            sweet_code;
        Tokenizer = new tokenizer(js_source_text, opt, indent_string);
        tokens = Tokenizer.tokenize();
        token_pos = 0;
        while (local_token = get_token()) {
          for (var i = 0; i < local_token.comments_before.length; i++) {
            handle_token(local_token.comments_before[i]);
          }
          handle_token(local_token);
          last_last_text = flags.last_text;
          last_type = local_token.type;
          flags.last_text = local_token.text;
          token_pos += 1;
        }
        sweet_code = output.get_code();
        if (opt.end_with_newline) {
          sweet_code += '\n';
        }
        if (opt.eol != '\n') {
          sweet_code = sweet_code.replace(/[\n]/g, opt.eol);
        }
        return sweet_code;
      };
      function handle_token(local_token) {
        var newlines = local_token.newlines;
        var keep_whitespace = opt.keep_array_indentation && is_array(flags.mode);
        if (keep_whitespace) {
          for (i = 0; i < newlines; i += 1) {
            print_newline(i > 0);
          }
        } else {
          if (opt.max_preserve_newlines && newlines > opt.max_preserve_newlines) {
            newlines = opt.max_preserve_newlines;
          }
          if (opt.preserve_newlines) {
            if (local_token.newlines > 1) {
              print_newline();
              for (var i = 1; i < newlines; i += 1) {
                print_newline(true);
              }
            }
          }
        }
        current_token = local_token;
        handlers[current_token.type]();
      }
      function split_newlines(s) {
        s = s.replace(/\x0d/g, '');
        var out = [],
            idx = s.indexOf("\n");
        while (idx !== -1) {
          out.push(s.substring(0, idx));
          s = s.substring(idx + 1);
          idx = s.indexOf("\n");
        }
        if (s.length) {
          out.push(s);
        }
        return out;
      }
      function allow_wrap_or_preserved_newline(force_linewrap) {
        force_linewrap = (force_linewrap === undefined) ? false : force_linewrap;
        if (output.just_added_newline()) {
          return ;
        }
        if ((opt.preserve_newlines && current_token.wanted_newline) || force_linewrap) {
          print_newline(false, true);
        } else if (opt.wrap_line_length) {
          var proposed_line_length = output.current_line.get_character_count() + current_token.text.length + (output.space_before_token ? 1 : 0);
          if (proposed_line_length >= opt.wrap_line_length) {
            print_newline(false, true);
          }
        }
      }
      function print_newline(force_newline, preserve_statement_flags) {
        if (!preserve_statement_flags) {
          if (flags.last_text !== ';' && flags.last_text !== ',' && flags.last_text !== '=' && last_type !== 'TK_OPERATOR') {
            while (flags.mode === MODE.Statement && !flags.if_block && !flags.do_block) {
              restore_mode();
            }
          }
        }
        if (output.add_new_line(force_newline)) {
          flags.multiline_frame = true;
        }
      }
      function print_token_line_indentation() {
        if (output.just_added_newline()) {
          if (opt.keep_array_indentation && is_array(flags.mode) && current_token.wanted_newline) {
            output.current_line.push(current_token.whitespace_before);
            output.space_before_token = false;
          } else if (output.set_indent(flags.indentation_level)) {
            flags.line_indent_level = flags.indentation_level;
          }
        }
      }
      function print_token(printable_token) {
        if (output.raw) {
          output.add_raw_token(current_token);
          return ;
        }
        if (opt.comma_first && last_type === 'TK_COMMA' && output.just_added_newline()) {
          if (output.previous_line.last() === ',') {
            output.previous_line.pop();
            print_token_line_indentation();
            output.add_token(',');
            output.space_before_token = true;
          }
        }
        printable_token = printable_token || current_token.text;
        print_token_line_indentation();
        output.add_token(printable_token);
      }
      function indent() {
        flags.indentation_level += 1;
      }
      function deindent() {
        if (flags.indentation_level > 0 && ((!flags.parent) || flags.indentation_level > flags.parent.indentation_level))
          flags.indentation_level -= 1;
      }
      function set_mode(mode) {
        if (flags) {
          flag_store.push(flags);
          previous_flags = flags;
        } else {
          previous_flags = create_flags(null, mode);
        }
        flags = create_flags(previous_flags, mode);
      }
      function is_array(mode) {
        return mode === MODE.ArrayLiteral;
      }
      function is_expression(mode) {
        return in_array(mode, [MODE.Expression, MODE.ForInitializer, MODE.Conditional]);
      }
      function restore_mode() {
        if (flag_store.length > 0) {
          previous_flags = flags;
          flags = flag_store.pop();
          if (previous_flags.mode === MODE.Statement) {
            output.remove_redundant_indentation(previous_flags);
          }
        }
      }
      function start_of_object_property() {
        return flags.parent.mode === MODE.ObjectLiteral && flags.mode === MODE.Statement && ((flags.last_text === ':' && flags.ternary_depth === 0) || (last_type === 'TK_RESERVED' && in_array(flags.last_text, ['get', 'set'])));
      }
      function start_of_statement() {
        if ((last_type === 'TK_RESERVED' && in_array(flags.last_text, ['var', 'let', 'const']) && current_token.type === 'TK_WORD') || (last_type === 'TK_RESERVED' && flags.last_text === 'do') || (last_type === 'TK_RESERVED' && flags.last_text === 'return' && !current_token.wanted_newline) || (last_type === 'TK_RESERVED' && flags.last_text === 'else' && !(current_token.type === 'TK_RESERVED' && current_token.text === 'if')) || (last_type === 'TK_END_EXPR' && (previous_flags.mode === MODE.ForInitializer || previous_flags.mode === MODE.Conditional)) || (last_type === 'TK_WORD' && flags.mode === MODE.BlockStatement && !flags.in_case && !(current_token.text === '--' || current_token.text === '++') && last_last_text !== 'function' && current_token.type !== 'TK_WORD' && current_token.type !== 'TK_RESERVED') || (flags.mode === MODE.ObjectLiteral && ((flags.last_text === ':' && flags.ternary_depth === 0) || (last_type === 'TK_RESERVED' && in_array(flags.last_text, ['get', 'set']))))) {
          set_mode(MODE.Statement);
          indent();
          if (last_type === 'TK_RESERVED' && in_array(flags.last_text, ['var', 'let', 'const']) && current_token.type === 'TK_WORD') {
            flags.declaration_statement = true;
          }
          if (!start_of_object_property()) {
            allow_wrap_or_preserved_newline(current_token.type === 'TK_RESERVED' && in_array(current_token.text, ['do', 'for', 'if', 'while']));
          }
          return true;
        }
        return false;
      }
      function all_lines_start_with(lines, c) {
        for (var i = 0; i < lines.length; i++) {
          var line = trim(lines[i]);
          if (line.charAt(0) !== c) {
            return false;
          }
        }
        return true;
      }
      function each_line_matches_indent(lines, indent) {
        var i = 0,
            len = lines.length,
            line;
        for (; i < len; i++) {
          line = lines[i];
          if (line && line.indexOf(indent) !== 0) {
            return false;
          }
        }
        return true;
      }
      function is_special_word(word) {
        return in_array(word, ['case', 'return', 'do', 'if', 'throw', 'else']);
      }
      function get_token(offset) {
        var index = token_pos + (offset || 0);
        return (index < 0 || index >= tokens.length) ? null : tokens[index];
      }
      function handle_start_expr() {
        if (start_of_statement()) {}
        var next_mode = MODE.Expression;
        if (current_token.text === '[') {
          if (last_type === 'TK_WORD' || flags.last_text === ')') {
            if (last_type === 'TK_RESERVED' && in_array(flags.last_text, Tokenizer.line_starters)) {
              output.space_before_token = true;
            }
            set_mode(next_mode);
            print_token();
            indent();
            if (opt.space_in_paren) {
              output.space_before_token = true;
            }
            return ;
          }
          next_mode = MODE.ArrayLiteral;
          if (is_array(flags.mode)) {
            if (flags.last_text === '[' || (flags.last_text === ',' && (last_last_text === ']' || last_last_text === '}'))) {
              if (!opt.keep_array_indentation) {
                print_newline();
              }
            }
          }
        } else {
          if (last_type === 'TK_RESERVED' && flags.last_text === 'for') {
            next_mode = MODE.ForInitializer;
          } else if (last_type === 'TK_RESERVED' && in_array(flags.last_text, ['if', 'while'])) {
            next_mode = MODE.Conditional;
          } else {}
        }
        if (flags.last_text === ';' || last_type === 'TK_START_BLOCK') {
          print_newline();
        } else if (last_type === 'TK_END_EXPR' || last_type === 'TK_START_EXPR' || last_type === 'TK_END_BLOCK' || flags.last_text === '.') {
          allow_wrap_or_preserved_newline(current_token.wanted_newline);
        } else if (!(last_type === 'TK_RESERVED' && current_token.text === '(') && last_type !== 'TK_WORD' && last_type !== 'TK_OPERATOR') {
          output.space_before_token = true;
        } else if ((last_type === 'TK_RESERVED' && (flags.last_word === 'function' || flags.last_word === 'typeof')) || (flags.last_text === '*' && last_last_text === 'function')) {
          if (opt.space_after_anon_function) {
            output.space_before_token = true;
          }
        } else if (last_type === 'TK_RESERVED' && (in_array(flags.last_text, Tokenizer.line_starters) || flags.last_text === 'catch')) {
          if (opt.space_before_conditional) {
            output.space_before_token = true;
          }
        }
        if (current_token.text === '(' && last_type === 'TK_RESERVED' && flags.last_word === 'await') {
          output.space_before_token = true;
        }
        if (current_token.text === '(') {
          if (last_type === 'TK_EQUALS' || last_type === 'TK_OPERATOR') {
            if (!start_of_object_property()) {
              allow_wrap_or_preserved_newline();
            }
          }
        }
        set_mode(next_mode);
        print_token();
        if (opt.space_in_paren) {
          output.space_before_token = true;
        }
        indent();
      }
      function handle_end_expr() {
        while (flags.mode === MODE.Statement) {
          restore_mode();
        }
        if (flags.multiline_frame) {
          allow_wrap_or_preserved_newline(current_token.text === ']' && is_array(flags.mode) && !opt.keep_array_indentation);
        }
        if (opt.space_in_paren) {
          if (last_type === 'TK_START_EXPR' && !opt.space_in_empty_paren) {
            output.trim();
            output.space_before_token = false;
          } else {
            output.space_before_token = true;
          }
        }
        if (current_token.text === ']' && opt.keep_array_indentation) {
          print_token();
          restore_mode();
        } else {
          restore_mode();
          print_token();
        }
        output.remove_redundant_indentation(previous_flags);
        if (flags.do_while && previous_flags.mode === MODE.Conditional) {
          previous_flags.mode = MODE.Expression;
          flags.do_block = false;
          flags.do_while = false;
        }
      }
      function handle_start_block() {
        var next_token = get_token(1);
        var second_token = get_token(2);
        if (second_token && ((second_token.text === ':' && in_array(next_token.type, ['TK_STRING', 'TK_WORD', 'TK_RESERVED'])) || (in_array(next_token.text, ['get', 'set']) && in_array(second_token.type, ['TK_WORD', 'TK_RESERVED'])))) {
          if (!in_array(last_last_text, ['class', 'interface'])) {
            set_mode(MODE.ObjectLiteral);
          } else {
            set_mode(MODE.BlockStatement);
          }
        } else {
          set_mode(MODE.BlockStatement);
        }
        var empty_braces = !next_token.comments_before.length && next_token.text === '}';
        var empty_anonymous_function = empty_braces && flags.last_word === 'function' && last_type === 'TK_END_EXPR';
        if (opt.brace_style === "expand" || (opt.brace_style === "none" && current_token.wanted_newline)) {
          if (last_type !== 'TK_OPERATOR' && (empty_anonymous_function || last_type === 'TK_EQUALS' || (last_type === 'TK_RESERVED' && is_special_word(flags.last_text) && flags.last_text !== 'else'))) {
            output.space_before_token = true;
          } else {
            print_newline(false, true);
          }
        } else {
          if (last_type !== 'TK_OPERATOR' && last_type !== 'TK_START_EXPR') {
            if (last_type === 'TK_START_BLOCK') {
              print_newline();
            } else {
              output.space_before_token = true;
            }
          } else {
            if (is_array(previous_flags.mode) && flags.last_text === ',') {
              if (last_last_text === '}') {
                output.space_before_token = true;
              } else {
                print_newline();
              }
            }
          }
        }
        print_token();
        indent();
      }
      function handle_end_block() {
        while (flags.mode === MODE.Statement) {
          restore_mode();
        }
        var empty_braces = last_type === 'TK_START_BLOCK';
        if (opt.brace_style === "expand") {
          if (!empty_braces) {
            print_newline();
          }
        } else {
          if (!empty_braces) {
            if (is_array(flags.mode) && opt.keep_array_indentation) {
              opt.keep_array_indentation = false;
              print_newline();
              opt.keep_array_indentation = true;
            } else {
              print_newline();
            }
          }
        }
        restore_mode();
        print_token();
      }
      function handle_word() {
        if (current_token.type === 'TK_RESERVED' && flags.mode !== MODE.ObjectLiteral && in_array(current_token.text, ['set', 'get'])) {
          current_token.type = 'TK_WORD';
        }
        if (current_token.type === 'TK_RESERVED' && flags.mode === MODE.ObjectLiteral) {
          var next_token = get_token(1);
          if (next_token.text == ':') {
            current_token.type = 'TK_WORD';
          }
        }
        if (start_of_statement()) {} else if (current_token.wanted_newline && !is_expression(flags.mode) && (last_type !== 'TK_OPERATOR' || (flags.last_text === '--' || flags.last_text === '++')) && last_type !== 'TK_EQUALS' && (opt.preserve_newlines || !(last_type === 'TK_RESERVED' && in_array(flags.last_text, ['var', 'let', 'const', 'set', 'get'])))) {
          print_newline();
        }
        if (flags.do_block && !flags.do_while) {
          if (current_token.type === 'TK_RESERVED' && current_token.text === 'while') {
            output.space_before_token = true;
            print_token();
            output.space_before_token = true;
            flags.do_while = true;
            return ;
          } else {
            print_newline();
            flags.do_block = false;
          }
        }
        if (flags.if_block) {
          if (!flags.else_block && (current_token.type === 'TK_RESERVED' && current_token.text === 'else')) {
            flags.else_block = true;
          } else {
            while (flags.mode === MODE.Statement) {
              restore_mode();
            }
            flags.if_block = false;
            flags.else_block = false;
          }
        }
        if (current_token.type === 'TK_RESERVED' && (current_token.text === 'case' || (current_token.text === 'default' && flags.in_case_statement))) {
          print_newline();
          if (flags.case_body || opt.jslint_happy) {
            deindent();
            flags.case_body = false;
          }
          print_token();
          flags.in_case = true;
          flags.in_case_statement = true;
          return ;
        }
        if (current_token.type === 'TK_RESERVED' && current_token.text === 'function') {
          if (in_array(flags.last_text, ['}', ';']) || (output.just_added_newline() && !in_array(flags.last_text, ['[', '{', ':', '=', ',']))) {
            if (!output.just_added_blankline() && !current_token.comments_before.length) {
              print_newline();
              print_newline(true);
            }
          }
          if (last_type === 'TK_RESERVED' || last_type === 'TK_WORD') {
            if (last_type === 'TK_RESERVED' && in_array(flags.last_text, ['get', 'set', 'new', 'return', 'export', 'async'])) {
              output.space_before_token = true;
            } else if (last_type === 'TK_RESERVED' && flags.last_text === 'default' && last_last_text === 'export') {
              output.space_before_token = true;
            } else {
              print_newline();
            }
          } else if (last_type === 'TK_OPERATOR' || flags.last_text === '=') {
            output.space_before_token = true;
          } else if (!flags.multiline_frame && (is_expression(flags.mode) || is_array(flags.mode))) {} else {
            print_newline();
          }
        }
        if (last_type === 'TK_COMMA' || last_type === 'TK_START_EXPR' || last_type === 'TK_EQUALS' || last_type === 'TK_OPERATOR') {
          if (!start_of_object_property()) {
            allow_wrap_or_preserved_newline();
          }
        }
        if (current_token.type === 'TK_RESERVED' && in_array(current_token.text, ['function', 'get', 'set'])) {
          print_token();
          flags.last_word = current_token.text;
          return ;
        }
        prefix = 'NONE';
        if (last_type === 'TK_END_BLOCK') {
          if (!(current_token.type === 'TK_RESERVED' && in_array(current_token.text, ['else', 'catch', 'finally']))) {
            prefix = 'NEWLINE';
          } else {
            if (opt.brace_style === "expand" || opt.brace_style === "end-expand" || (opt.brace_style === "none" && current_token.wanted_newline)) {
              prefix = 'NEWLINE';
            } else {
              prefix = 'SPACE';
              output.space_before_token = true;
            }
          }
        } else if (last_type === 'TK_SEMICOLON' && flags.mode === MODE.BlockStatement) {
          prefix = 'NEWLINE';
        } else if (last_type === 'TK_SEMICOLON' && is_expression(flags.mode)) {
          prefix = 'SPACE';
        } else if (last_type === 'TK_STRING') {
          prefix = 'NEWLINE';
        } else if (last_type === 'TK_RESERVED' || last_type === 'TK_WORD' || (flags.last_text === '*' && last_last_text === 'function')) {
          prefix = 'SPACE';
        } else if (last_type === 'TK_START_BLOCK') {
          prefix = 'NEWLINE';
        } else if (last_type === 'TK_END_EXPR') {
          output.space_before_token = true;
          prefix = 'NEWLINE';
        }
        if (current_token.type === 'TK_RESERVED' && in_array(current_token.text, Tokenizer.line_starters) && flags.last_text !== ')') {
          if (flags.last_text === 'else' || flags.last_text === 'export') {
            prefix = 'SPACE';
          } else {
            prefix = 'NEWLINE';
          }
        }
        if (current_token.type === 'TK_RESERVED' && in_array(current_token.text, ['else', 'catch', 'finally'])) {
          if (last_type !== 'TK_END_BLOCK' || opt.brace_style === "expand" || opt.brace_style === "end-expand" || (opt.brace_style === "none" && current_token.wanted_newline)) {
            print_newline();
          } else {
            output.trim(true);
            var line = output.current_line;
            if (line.last() !== '}') {
              print_newline();
            }
            output.space_before_token = true;
          }
        } else if (prefix === 'NEWLINE') {
          if (last_type === 'TK_RESERVED' && is_special_word(flags.last_text)) {
            output.space_before_token = true;
          } else if (last_type !== 'TK_END_EXPR') {
            if ((last_type !== 'TK_START_EXPR' || !(current_token.type === 'TK_RESERVED' && in_array(current_token.text, ['var', 'let', 'const']))) && flags.last_text !== ':') {
              if (current_token.type === 'TK_RESERVED' && current_token.text === 'if' && flags.last_text === 'else') {
                output.space_before_token = true;
              } else {
                print_newline();
              }
            }
          } else if (current_token.type === 'TK_RESERVED' && in_array(current_token.text, Tokenizer.line_starters) && flags.last_text !== ')') {
            print_newline();
          }
        } else if (flags.multiline_frame && is_array(flags.mode) && flags.last_text === ',' && last_last_text === '}') {
          print_newline();
        } else if (prefix === 'SPACE') {
          output.space_before_token = true;
        }
        print_token();
        flags.last_word = current_token.text;
        if (current_token.type === 'TK_RESERVED' && current_token.text === 'do') {
          flags.do_block = true;
        }
        if (current_token.type === 'TK_RESERVED' && current_token.text === 'if') {
          flags.if_block = true;
        }
      }
      function handle_semicolon() {
        if (start_of_statement()) {
          output.space_before_token = false;
        }
        while (flags.mode === MODE.Statement && !flags.if_block && !flags.do_block) {
          restore_mode();
        }
        print_token();
      }
      function handle_string() {
        if (start_of_statement()) {
          output.space_before_token = true;
        } else if (last_type === 'TK_RESERVED' || last_type === 'TK_WORD') {
          output.space_before_token = true;
        } else if (last_type === 'TK_COMMA' || last_type === 'TK_START_EXPR' || last_type === 'TK_EQUALS' || last_type === 'TK_OPERATOR') {
          if (!start_of_object_property()) {
            allow_wrap_or_preserved_newline();
          }
        } else {
          print_newline();
        }
        print_token();
      }
      function handle_equals() {
        if (start_of_statement()) {}
        if (flags.declaration_statement) {
          flags.declaration_assignment = true;
        }
        output.space_before_token = true;
        print_token();
        output.space_before_token = true;
      }
      function handle_comma() {
        if (flags.declaration_statement) {
          if (is_expression(flags.parent.mode)) {
            flags.declaration_assignment = false;
          }
          print_token();
          if (flags.declaration_assignment) {
            flags.declaration_assignment = false;
            print_newline(false, true);
          } else {
            output.space_before_token = true;
            if (opt.comma_first) {
              allow_wrap_or_preserved_newline();
            }
          }
          return ;
        }
        print_token();
        if (flags.mode === MODE.ObjectLiteral || (flags.mode === MODE.Statement && flags.parent.mode === MODE.ObjectLiteral)) {
          if (flags.mode === MODE.Statement) {
            restore_mode();
          }
          print_newline();
        } else {
          output.space_before_token = true;
          if (opt.comma_first) {
            allow_wrap_or_preserved_newline();
          }
        }
      }
      function handle_operator() {
        if (start_of_statement()) {}
        if (last_type === 'TK_RESERVED' && is_special_word(flags.last_text)) {
          output.space_before_token = true;
          print_token();
          return ;
        }
        if (current_token.text === '*' && last_type === 'TK_DOT') {
          print_token();
          return ;
        }
        if (current_token.text === ':' && flags.in_case) {
          flags.case_body = true;
          indent();
          print_token();
          print_newline();
          flags.in_case = false;
          return ;
        }
        if (current_token.text === '::') {
          print_token();
          return ;
        }
        if (last_type === 'TK_OPERATOR') {
          allow_wrap_or_preserved_newline();
        }
        var space_before = true;
        var space_after = true;
        if (in_array(current_token.text, ['--', '++', '!', '~']) || (in_array(current_token.text, ['-', '+']) && (in_array(last_type, ['TK_START_BLOCK', 'TK_START_EXPR', 'TK_EQUALS', 'TK_OPERATOR']) || in_array(flags.last_text, Tokenizer.line_starters) || flags.last_text === ','))) {
          space_before = false;
          space_after = false;
          if (current_token.wanted_newline && (current_token.text === '--' || current_token.text === '++')) {
            print_newline(false, true);
          }
          if (flags.last_text === ';' && is_expression(flags.mode)) {
            space_before = true;
          }
          if (last_type === 'TK_RESERVED') {
            space_before = true;
          } else if (last_type === 'TK_END_EXPR') {
            space_before = !(flags.last_text === ']' && (current_token.text === '--' || current_token.text === '++'));
          } else if (last_type === 'TK_OPERATOR') {
            space_before = in_array(current_token.text, ['--', '-', '++', '+']) && in_array(flags.last_text, ['--', '-', '++', '+']);
            if (in_array(current_token.text, ['+', '-']) && in_array(flags.last_text, ['--', '++'])) {
              space_after = true;
            }
          }
          if ((flags.mode === MODE.BlockStatement || flags.mode === MODE.Statement) && (flags.last_text === '{' || flags.last_text === ';')) {
            print_newline();
          }
        } else if (current_token.text === ':') {
          if (flags.ternary_depth === 0) {
            space_before = false;
          } else {
            flags.ternary_depth -= 1;
          }
        } else if (current_token.text === '?') {
          flags.ternary_depth += 1;
        } else if (current_token.text === '*' && last_type === 'TK_RESERVED' && flags.last_text === 'function') {
          space_before = false;
          space_after = false;
        }
        output.space_before_token = output.space_before_token || space_before;
        print_token();
        output.space_before_token = space_after;
      }
      function handle_block_comment() {
        if (output.raw) {
          output.add_raw_token(current_token);
          if (current_token.directives && current_token.directives['preserve'] === 'end') {
            if (!opt.test_output_raw) {
              output.raw = false;
            }
          }
          return ;
        }
        if (current_token.directives) {
          print_newline(false, true);
          print_token();
          if (current_token.directives['preserve'] === 'start') {
            output.raw = true;
          }
          print_newline(false, true);
          return ;
        }
        if (!acorn.newline.test(current_token.text) && !current_token.wanted_newline) {
          output.space_before_token = true;
          print_token();
          output.space_before_token = true;
          return ;
        }
        var lines = split_newlines(current_token.text);
        var j;
        var javadoc = false;
        var starless = false;
        var lastIndent = current_token.whitespace_before;
        var lastIndentLength = lastIndent.length;
        print_newline(false, true);
        if (lines.length > 1) {
          if (all_lines_start_with(lines.slice(1), '*')) {
            javadoc = true;
          } else if (each_line_matches_indent(lines.slice(1), lastIndent)) {
            starless = true;
          }
        }
        print_token(lines[0]);
        for (j = 1; j < lines.length; j++) {
          print_newline(false, true);
          if (javadoc) {
            print_token(' ' + ltrim(lines[j]));
          } else if (starless && lines[j].length > lastIndentLength) {
            print_token(lines[j].substring(lastIndentLength));
          } else {
            output.add_token(lines[j]);
          }
        }
        print_newline(false, true);
      }
      function handle_comment() {
        if (current_token.wanted_newline) {
          print_newline(false, true);
        } else {
          output.trim(true);
        }
        output.space_before_token = true;
        print_token();
        print_newline(false, true);
      }
      function handle_dot() {
        if (start_of_statement()) {}
        if (last_type === 'TK_RESERVED' && is_special_word(flags.last_text)) {
          output.space_before_token = true;
        } else {
          allow_wrap_or_preserved_newline(flags.last_text === ')' && opt.break_chained_methods);
        }
        print_token();
      }
      function handle_unknown() {
        print_token();
        if (current_token.text[current_token.text.length - 1] === '\n') {
          print_newline();
        }
      }
      function handle_eof() {
        while (flags.mode === MODE.Statement) {
          restore_mode();
        }
      }
    }
    function OutputLine(parent) {
      var _character_count = 0;
      var _indent_count = -1;
      var _items = [];
      var _empty = true;
      this.set_indent = function(level) {
        _character_count = parent.baseIndentLength + level * parent.indent_length;
        _indent_count = level;
      };
      this.get_character_count = function() {
        return _character_count;
      };
      this.is_empty = function() {
        return _empty;
      };
      this.last = function() {
        if (!this._empty) {
          return _items[_items.length - 1];
        } else {
          return null;
        }
      };
      this.push = function(input) {
        _items.push(input);
        _character_count += input.length;
        _empty = false;
      };
      this.pop = function() {
        var item = null;
        if (!_empty) {
          item = _items.pop();
          _character_count -= item.length;
          _empty = _items.length === 0;
        }
        return item;
      };
      this.remove_indent = function() {
        if (_indent_count > 0) {
          _indent_count -= 1;
          _character_count -= parent.indent_length;
        }
      };
      this.trim = function() {
        while (this.last() === ' ') {
          var item = _items.pop();
          _character_count -= 1;
        }
        _empty = _items.length === 0;
      };
      this.toString = function() {
        var result = '';
        if (!this._empty) {
          if (_indent_count >= 0) {
            result = parent.indent_cache[_indent_count];
          }
          result += _items.join('');
        }
        return result;
      };
    }
    function Output(indent_string, baseIndentString) {
      baseIndentString = baseIndentString || '';
      this.indent_cache = [baseIndentString];
      this.baseIndentLength = baseIndentString.length;
      this.indent_length = indent_string.length;
      this.raw = false;
      var lines = [];
      this.baseIndentString = baseIndentString;
      this.indent_string = indent_string;
      this.previous_line = null;
      this.current_line = null;
      this.space_before_token = false;
      this.add_outputline = function() {
        this.previous_line = this.current_line;
        this.current_line = new OutputLine(this);
        lines.push(this.current_line);
      };
      this.add_outputline();
      this.get_line_number = function() {
        return lines.length;
      };
      this.add_new_line = function(force_newline) {
        if (this.get_line_number() === 1 && this.just_added_newline()) {
          return false;
        }
        if (force_newline || !this.just_added_newline()) {
          if (!this.raw) {
            this.add_outputline();
          }
          return true;
        }
        return false;
      };
      this.get_code = function() {
        var sweet_code = lines.join('\n').replace(/[\r\n\t ]+$/, '');
        return sweet_code;
      };
      this.set_indent = function(level) {
        if (lines.length > 1) {
          while (level >= this.indent_cache.length) {
            this.indent_cache.push(this.indent_cache[this.indent_cache.length - 1] + this.indent_string);
          }
          this.current_line.set_indent(level);
          return true;
        }
        this.current_line.set_indent(0);
        return false;
      };
      this.add_raw_token = function(token) {
        for (var x = 0; x < token.newlines; x++) {
          this.add_outputline();
        }
        this.current_line.push(token.whitespace_before);
        this.current_line.push(token.text);
        this.space_before_token = false;
      };
      this.add_token = function(printable_token) {
        this.add_space_before_token();
        this.current_line.push(printable_token);
      };
      this.add_space_before_token = function() {
        if (this.space_before_token && !this.just_added_newline()) {
          this.current_line.push(' ');
        }
        this.space_before_token = false;
      };
      this.remove_redundant_indentation = function(frame) {
        if (frame.multiline_frame || frame.mode === MODE.ForInitializer || frame.mode === MODE.Conditional) {
          return ;
        }
        var index = frame.start_line_index;
        var line;
        var output_length = lines.length;
        while (index < output_length) {
          lines[index].remove_indent();
          index++;
        }
      };
      this.trim = function(eat_newlines) {
        eat_newlines = (eat_newlines === undefined) ? false : eat_newlines;
        this.current_line.trim(indent_string, baseIndentString);
        while (eat_newlines && lines.length > 1 && this.current_line.is_empty()) {
          lines.pop();
          this.current_line = lines[lines.length - 1];
          this.current_line.trim();
        }
        this.previous_line = lines.length > 1 ? lines[lines.length - 2] : null;
      };
      this.just_added_newline = function() {
        return this.current_line.is_empty();
      };
      this.just_added_blankline = function() {
        if (this.just_added_newline()) {
          if (lines.length === 1) {
            return true;
          }
          var line = lines[lines.length - 2];
          return line.is_empty();
        }
        return false;
      };
    }
    var Token = function(type, text, newlines, whitespace_before, mode, parent) {
      this.type = type;
      this.text = text;
      this.comments_before = [];
      this.newlines = newlines || 0;
      this.wanted_newline = newlines > 0;
      this.whitespace_before = whitespace_before || '';
      this.parent = null;
      this.directives = null;
    };
    function tokenizer(input, opts, indent_string) {
      var whitespace = "\n\r\t ".split('');
      var digit = /[0-9]/;
      var digit_hex = /[0123456789abcdefABCDEF]/;
      var punct = ('+ - * / % & ++ -- = += -= *= /= %= == === != !== > < >= <= >> << >>> >>>= >>= <<= && &= | || ! ~ , : ? ^ ^= |= :: =>' + ' <%= <% %> <?= <? ?>').split(' ');
      this.line_starters = 'continue,try,throw,return,var,let,const,if,switch,case,default,for,while,break,function,import,export'.split(',');
      var reserved_words = this.line_starters.concat(['do', 'in', 'else', 'get', 'set', 'new', 'catch', 'finally', 'typeof', 'yield', 'async', 'await']);
      var block_comment_pattern = /([\s\S]*?)((?:\*\/)|$)/g;
      var comment_pattern = /([^\n\r\u2028\u2029]*)/g;
      var directives_block_pattern = /\/\* beautify( \w+[:]\w+)+ \*\//g;
      var directive_pattern = / (\w+)[:](\w+)/g;
      var directives_end_ignore_pattern = /([\s\S]*?)((?:\/\*\sbeautify\signore:end\s\*\/)|$)/g;
      var template_pattern = /((<\?php|<\?=)[\s\S]*?\?>)|(<%[\s\S]*?%>)/g;
      var n_newlines,
          whitespace_before_token,
          in_html_comment,
          tokens,
          parser_pos;
      var input_length;
      this.tokenize = function() {
        input_length = input.length;
        parser_pos = 0;
        in_html_comment = false;
        tokens = [];
        var next,
            last;
        var token_values;
        var open = null;
        var open_stack = [];
        var comments = [];
        while (!(last && last.type === 'TK_EOF')) {
          token_values = tokenize_next();
          next = new Token(token_values[1], token_values[0], n_newlines, whitespace_before_token);
          while (next.type === 'TK_COMMENT' || next.type === 'TK_BLOCK_COMMENT' || next.type === 'TK_UNKNOWN') {
            if (next.type === 'TK_BLOCK_COMMENT') {
              next.directives = token_values[2];
            }
            comments.push(next);
            token_values = tokenize_next();
            next = new Token(token_values[1], token_values[0], n_newlines, whitespace_before_token);
          }
          if (comments.length) {
            next.comments_before = comments;
            comments = [];
          }
          if (next.type === 'TK_START_BLOCK' || next.type === 'TK_START_EXPR') {
            next.parent = last;
            open_stack.push(open);
            open = next;
          } else if ((next.type === 'TK_END_BLOCK' || next.type === 'TK_END_EXPR') && (open && ((next.text === ']' && open.text === '[') || (next.text === ')' && open.text === '(') || (next.text === '}' && open.text === '{')))) {
            next.parent = open.parent;
            open = open_stack.pop();
          }
          tokens.push(next);
          last = next;
        }
        return tokens;
      };
      function get_directives(text) {
        if (!text.match(directives_block_pattern)) {
          return null;
        }
        var directives = {};
        directive_pattern.lastIndex = 0;
        var directive_match = directive_pattern.exec(text);
        while (directive_match) {
          directives[directive_match[1]] = directive_match[2];
          directive_match = directive_pattern.exec(text);
        }
        return directives;
      }
      function tokenize_next() {
        var i,
            resulting_string;
        var whitespace_on_this_line = [];
        n_newlines = 0;
        whitespace_before_token = '';
        if (parser_pos >= input_length) {
          return ['', 'TK_EOF'];
        }
        var last_token;
        if (tokens.length) {
          last_token = tokens[tokens.length - 1];
        } else {
          last_token = new Token('TK_START_BLOCK', '{');
        }
        var c = input.charAt(parser_pos);
        parser_pos += 1;
        while (in_array(c, whitespace)) {
          if (acorn.newline.test(c)) {
            if (!(c === '\n' && input.charAt(parser_pos - 2) === '\r')) {
              n_newlines += 1;
              whitespace_on_this_line = [];
            }
          } else {
            whitespace_on_this_line.push(c);
          }
          if (parser_pos >= input_length) {
            return ['', 'TK_EOF'];
          }
          c = input.charAt(parser_pos);
          parser_pos += 1;
        }
        if (whitespace_on_this_line.length) {
          whitespace_before_token = whitespace_on_this_line.join('');
        }
        if (digit.test(c)) {
          var allow_decimal = true;
          var allow_e = true;
          var local_digit = digit;
          if (c === '0' && parser_pos < input_length && /[Xx]/.test(input.charAt(parser_pos))) {
            allow_decimal = false;
            allow_e = false;
            c += input.charAt(parser_pos);
            parser_pos += 1;
            local_digit = digit_hex;
          } else {
            c = '';
            parser_pos -= 1;
          }
          while (parser_pos < input_length && local_digit.test(input.charAt(parser_pos))) {
            c += input.charAt(parser_pos);
            parser_pos += 1;
            if (allow_decimal && parser_pos < input_length && input.charAt(parser_pos) === '.') {
              c += input.charAt(parser_pos);
              parser_pos += 1;
              allow_decimal = false;
            }
            if (allow_e && parser_pos < input_length && /[Ee]/.test(input.charAt(parser_pos))) {
              c += input.charAt(parser_pos);
              parser_pos += 1;
              if (parser_pos < input_length && /[+-]/.test(input.charAt(parser_pos))) {
                c += input.charAt(parser_pos);
                parser_pos += 1;
              }
              allow_e = false;
              allow_decimal = false;
            }
          }
          return [c, 'TK_WORD'];
        }
        if (acorn.isIdentifierStart(input.charCodeAt(parser_pos - 1))) {
          if (parser_pos < input_length) {
            while (acorn.isIdentifierChar(input.charCodeAt(parser_pos))) {
              c += input.charAt(parser_pos);
              parser_pos += 1;
              if (parser_pos === input_length) {
                break;
              }
            }
          }
          if (!(last_token.type === 'TK_DOT' || (last_token.type === 'TK_RESERVED' && in_array(last_token.text, ['set', 'get']))) && in_array(c, reserved_words)) {
            if (c === 'in') {
              return [c, 'TK_OPERATOR'];
            }
            return [c, 'TK_RESERVED'];
          }
          return [c, 'TK_WORD'];
        }
        if (c === '(' || c === '[') {
          return [c, 'TK_START_EXPR'];
        }
        if (c === ')' || c === ']') {
          return [c, 'TK_END_EXPR'];
        }
        if (c === '{') {
          return [c, 'TK_START_BLOCK'];
        }
        if (c === '}') {
          return [c, 'TK_END_BLOCK'];
        }
        if (c === ';') {
          return [c, 'TK_SEMICOLON'];
        }
        if (c === '/') {
          var comment = '';
          if (input.charAt(parser_pos) === '*') {
            parser_pos += 1;
            block_comment_pattern.lastIndex = parser_pos;
            var comment_match = block_comment_pattern.exec(input);
            comment = '/*' + comment_match[0];
            parser_pos += comment_match[0].length;
            var directives = get_directives(comment);
            if (directives && directives['ignore'] === 'start') {
              directives_end_ignore_pattern.lastIndex = parser_pos;
              comment_match = directives_end_ignore_pattern.exec(input);
              comment += comment_match[0];
              parser_pos += comment_match[0].length;
            }
            comment = comment.replace(acorn.lineBreak, '\n');
            return [comment, 'TK_BLOCK_COMMENT', directives];
          }
          if (input.charAt(parser_pos) === '/') {
            parser_pos += 1;
            comment_pattern.lastIndex = parser_pos;
            var comment_match = comment_pattern.exec(input);
            comment = '//' + comment_match[0];
            parser_pos += comment_match[0].length;
            return [comment, 'TK_COMMENT'];
          }
        }
        if (c === '`' || c === "'" || c === '"' || ((c === '/') || (opts.e4x && c === "<" && input.slice(parser_pos - 1).match(/^<([-a-zA-Z:0-9_.]+|{[^{}]*}|!\[CDATA\[[\s\S]*?\]\])(\s+[-a-zA-Z:0-9_.]+\s*=\s*('[^']*'|"[^"]*"|{.*?}))*\s*(\/?)\s*>/))) && ((last_token.type === 'TK_RESERVED' && in_array(last_token.text, ['return', 'case', 'throw', 'else', 'do', 'typeof', 'yield'])) || (last_token.type === 'TK_END_EXPR' && last_token.text === ')' && last_token.parent && last_token.parent.type === 'TK_RESERVED' && in_array(last_token.parent.text, ['if', 'while', 'for'])) || (in_array(last_token.type, ['TK_COMMENT', 'TK_START_EXPR', 'TK_START_BLOCK', 'TK_END_BLOCK', 'TK_OPERATOR', 'TK_EQUALS', 'TK_EOF', 'TK_SEMICOLON', 'TK_COMMA'])))) {
          var sep = c,
              esc = false,
              has_char_escapes = false;
          resulting_string = c;
          if (sep === '/') {
            var in_char_class = false;
            while (parser_pos < input_length && ((esc || in_char_class || input.charAt(parser_pos) !== sep) && !acorn.newline.test(input.charAt(parser_pos)))) {
              resulting_string += input.charAt(parser_pos);
              if (!esc) {
                esc = input.charAt(parser_pos) === '\\';
                if (input.charAt(parser_pos) === '[') {
                  in_char_class = true;
                } else if (input.charAt(parser_pos) === ']') {
                  in_char_class = false;
                }
              } else {
                esc = false;
              }
              parser_pos += 1;
            }
          } else if (opts.e4x && sep === '<') {
            var xmlRegExp = /<(\/?)([-a-zA-Z:0-9_.]+|{[^{}]*}|!\[CDATA\[[\s\S]*?\]\])(\s+[-a-zA-Z:0-9_.]+\s*=\s*('[^']*'|"[^"]*"|{.*?}))*\s*(\/?)\s*>/g;
            var xmlStr = input.slice(parser_pos - 1);
            var match = xmlRegExp.exec(xmlStr);
            if (match && match.index === 0) {
              var rootTag = match[2];
              var depth = 0;
              while (match) {
                var isEndTag = !!match[1];
                var tagName = match[2];
                var isSingletonTag = (!!match[match.length - 1]) || (tagName.slice(0, 8) === "![CDATA[");
                if (tagName === rootTag && !isSingletonTag) {
                  if (isEndTag) {
                    --depth;
                  } else {
                    ++depth;
                  }
                }
                if (depth <= 0) {
                  break;
                }
                match = xmlRegExp.exec(xmlStr);
              }
              var xmlLength = match ? match.index + match[0].length : xmlStr.length;
              xmlStr = xmlStr.slice(0, xmlLength);
              parser_pos += xmlLength - 1;
              xmlStr = xmlStr.replace(acorn.lineBreak, '\n');
              return [xmlStr, "TK_STRING"];
            }
          } else {
            while (parser_pos < input_length && (esc || (input.charAt(parser_pos) !== sep && (sep === '`' || !acorn.newline.test(input.charAt(parser_pos)))))) {
              if ((esc || sep === '`') && acorn.newline.test(input.charAt(parser_pos))) {
                if (input.charAt(parser_pos) === '\r' && input.charAt(parser_pos + 1) === '\n') {
                  parser_pos += 1;
                }
                resulting_string += '\n';
              } else {
                resulting_string += input.charAt(parser_pos);
              }
              if (esc) {
                if (input.charAt(parser_pos) === 'x' || input.charAt(parser_pos) === 'u') {
                  has_char_escapes = true;
                }
                esc = false;
              } else {
                esc = input.charAt(parser_pos) === '\\';
              }
              parser_pos += 1;
            }
          }
          if (has_char_escapes && opts.unescape_strings) {
            resulting_string = unescape_string(resulting_string);
          }
          if (parser_pos < input_length && input.charAt(parser_pos) === sep) {
            resulting_string += sep;
            parser_pos += 1;
            if (sep === '/') {
              while (parser_pos < input_length && acorn.isIdentifierStart(input.charCodeAt(parser_pos))) {
                resulting_string += input.charAt(parser_pos);
                parser_pos += 1;
              }
            }
          }
          return [resulting_string, 'TK_STRING'];
        }
        if (c === '#') {
          if (tokens.length === 0 && input.charAt(parser_pos) === '!') {
            resulting_string = c;
            while (parser_pos < input_length && c !== '\n') {
              c = input.charAt(parser_pos);
              resulting_string += c;
              parser_pos += 1;
            }
            return [trim(resulting_string) + '\n', 'TK_UNKNOWN'];
          }
          var sharp = '#';
          if (parser_pos < input_length && digit.test(input.charAt(parser_pos))) {
            do {
              c = input.charAt(parser_pos);
              sharp += c;
              parser_pos += 1;
            } while (parser_pos < input_length && c !== '#' && c !== '=');
            if (c === '#') {} else if (input.charAt(parser_pos) === '[' && input.charAt(parser_pos + 1) === ']') {
              sharp += '[]';
              parser_pos += 2;
            } else if (input.charAt(parser_pos) === '{' && input.charAt(parser_pos + 1) === '}') {
              sharp += '{}';
              parser_pos += 2;
            }
            return [sharp, 'TK_WORD'];
          }
        }
        if (c === '<' && (input.charAt(parser_pos) === '?' || input.charAt(parser_pos) === '%')) {
          template_pattern.lastIndex = parser_pos - 1;
          var template_match = template_pattern.exec(input);
          if (template_match) {
            c = template_match[0];
            parser_pos += c.length - 1;
            c = c.replace(acorn.lineBreak, '\n');
            return [c, 'TK_STRING'];
          }
        }
        if (c === '<' && input.substring(parser_pos - 1, parser_pos + 3) === '<!--') {
          parser_pos += 3;
          c = '<!--';
          while (!acorn.newline.test(input.charAt(parser_pos)) && parser_pos < input_length) {
            c += input.charAt(parser_pos);
            parser_pos++;
          }
          in_html_comment = true;
          return [c, 'TK_COMMENT'];
        }
        if (c === '-' && in_html_comment && input.substring(parser_pos - 1, parser_pos + 2) === '-->') {
          in_html_comment = false;
          parser_pos += 2;
          return ['-->', 'TK_COMMENT'];
        }
        if (c === '.') {
          return [c, 'TK_DOT'];
        }
        if (in_array(c, punct)) {
          while (parser_pos < input_length && in_array(c + input.charAt(parser_pos), punct)) {
            c += input.charAt(parser_pos);
            parser_pos += 1;
            if (parser_pos >= input_length) {
              break;
            }
          }
          if (c === ',') {
            return [c, 'TK_COMMA'];
          } else if (c === '=') {
            return [c, 'TK_EQUALS'];
          } else {
            return [c, 'TK_OPERATOR'];
          }
        }
        return [c, 'TK_UNKNOWN'];
      }
      function unescape_string(s) {
        var esc = false,
            out = '',
            pos = 0,
            s_hex = '',
            escaped = 0,
            c;
        while (esc || pos < s.length) {
          c = s.charAt(pos);
          pos++;
          if (esc) {
            esc = false;
            if (c === 'x') {
              s_hex = s.substr(pos, 2);
              pos += 2;
            } else if (c === 'u') {
              s_hex = s.substr(pos, 4);
              pos += 4;
            } else {
              out += '\\' + c;
              continue;
            }
            if (!s_hex.match(/^[0123456789abcdefABCDEF]+$/)) {
              return s;
            }
            escaped = parseInt(s_hex, 16);
            if (escaped >= 0x00 && escaped < 0x20) {
              if (c === 'x') {
                out += '\\x' + s_hex;
              } else {
                out += '\\u' + s_hex;
              }
              continue;
            } else if (escaped === 0x22 || escaped === 0x27 || escaped === 0x5c) {
              out += '\\' + String.fromCharCode(escaped);
            } else if (c === 'x' && escaped > 0x7e && escaped <= 0xff) {
              return s;
            } else {
              out += String.fromCharCode(escaped);
            }
          } else if (c === '\\') {
            esc = true;
          } else {
            out += c;
          }
        }
        return out;
      }
    }
    if (typeof define === "function" && define.amd) {
      define([], function() {
        return {js_beautify: js_beautify};
      });
    } else if (typeof exports !== "undefined") {
      exports.js_beautify = js_beautify;
    } else if (typeof window !== "undefined") {
      window.js_beautify = js_beautify;
    } else if (typeof global !== "undefined") {
      global.js_beautify = js_beautify;
    }
  }());
  global.define = __define;
  return module.exports;
});

System.register("npm:js-beautify@1.5.10/js/lib/beautify-css", [], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  "format cjs";
  (function() {
    function css_beautify(source_text, options) {
      options = options || {};
      source_text = source_text || '';
      source_text = source_text.replace(/\r\n|[\r\u2028\u2029]/g, '\n');
      var indentSize = options.indent_size || 4;
      var indentCharacter = options.indent_char || ' ';
      var selectorSeparatorNewline = (options.selector_separator_newline === undefined) ? true : options.selector_separator_newline;
      var end_with_newline = (options.end_with_newline === undefined) ? false : options.end_with_newline;
      var newline_between_rules = (options.newline_between_rules === undefined) ? true : options.newline_between_rules;
      var eol = options.eol ? options.eol : '\n';
      if (typeof indentSize === "string") {
        indentSize = parseInt(indentSize, 10);
      }
      if (options.indent_with_tabs) {
        indentCharacter = '\t';
        indentSize = 1;
      }
      eol = eol.replace(/\\r/, '\r').replace(/\\n/, '\n');
      var whiteRe = /^\s+$/;
      var wordRe = /[\w$\-_]/;
      var pos = -1,
          ch;
      var parenLevel = 0;
      function next() {
        ch = source_text.charAt(++pos);
        return ch || '';
      }
      function peek(skipWhitespace) {
        var result = '';
        var prev_pos = pos;
        if (skipWhitespace) {
          eatWhitespace();
        }
        result = source_text.charAt(pos + 1) || '';
        pos = prev_pos - 1;
        next();
        return result;
      }
      function eatString(endChars) {
        var start = pos;
        while (next()) {
          if (ch === "\\") {
            next();
          } else if (endChars.indexOf(ch) !== -1) {
            break;
          } else if (ch === "\n") {
            break;
          }
        }
        return source_text.substring(start, pos + 1);
      }
      function peekString(endChar) {
        var prev_pos = pos;
        var str = eatString(endChar);
        pos = prev_pos - 1;
        next();
        return str;
      }
      function eatWhitespace() {
        var result = '';
        while (whiteRe.test(peek())) {
          next();
          result += ch;
        }
        return result;
      }
      function skipWhitespace() {
        var result = '';
        if (ch && whiteRe.test(ch)) {
          result = ch;
        }
        while (whiteRe.test(next())) {
          result += ch;
        }
        return result;
      }
      function eatComment(singleLine) {
        var start = pos;
        singleLine = peek() === "/";
        next();
        while (next()) {
          if (!singleLine && ch === "*" && peek() === "/") {
            next();
            break;
          } else if (singleLine && ch === "\n") {
            return source_text.substring(start, pos);
          }
        }
        return source_text.substring(start, pos) + ch;
      }
      function lookBack(str) {
        return source_text.substring(pos - str.length, pos).toLowerCase() === str;
      }
      function foundNestedPseudoClass() {
        var openParen = 0;
        for (var i = pos + 1; i < source_text.length; i++) {
          var ch = source_text.charAt(i);
          if (ch === "{") {
            return true;
          } else if (ch === '(') {
            openParen += 1;
          } else if (ch === ')') {
            if (openParen == 0) {
              return false;
            }
            openParen -= 1;
          } else if (ch === ";" || ch === "}") {
            return false;
          }
        }
        return false;
      }
      var basebaseIndentString = source_text.match(/^[\t ]*/)[0];
      var singleIndent = new Array(indentSize + 1).join(indentCharacter);
      var indentLevel = 0;
      var nestedLevel = 0;
      function indent() {
        indentLevel++;
        basebaseIndentString += singleIndent;
      }
      function outdent() {
        indentLevel--;
        basebaseIndentString = basebaseIndentString.slice(0, -indentSize);
      }
      var print = {};
      print["{"] = function(ch) {
        print.singleSpace();
        output.push(ch);
        print.newLine();
      };
      print["}"] = function(ch) {
        print.newLine();
        output.push(ch);
        print.newLine();
      };
      print._lastCharWhitespace = function() {
        return whiteRe.test(output[output.length - 1]);
      };
      print.newLine = function(keepWhitespace) {
        if (output.length) {
          if (!keepWhitespace && output[output.length - 1] !== '\n') {
            print.trim();
          }
          output.push('\n');
          if (basebaseIndentString) {
            output.push(basebaseIndentString);
          }
        }
      };
      print.singleSpace = function() {
        if (output.length && !print._lastCharWhitespace()) {
          output.push(' ');
        }
      };
      print.preserveSingleSpace = function() {
        if (isAfterSpace) {
          print.singleSpace();
        }
      };
      print.trim = function() {
        while (print._lastCharWhitespace()) {
          output.pop();
        }
      };
      var output = [];
      var insideRule = false;
      var insidePropertyValue = false;
      var enteringConditionalGroup = false;
      var top_ch = '';
      var last_top_ch = '';
      while (true) {
        var whitespace = skipWhitespace();
        var isAfterSpace = whitespace !== '';
        var isAfterNewline = whitespace.indexOf('\n') !== -1;
        last_top_ch = top_ch;
        top_ch = ch;
        if (!ch) {
          break;
        } else if (ch === '/' && peek() === '*') {
          var header = indentLevel === 0;
          if (isAfterNewline || header) {
            print.newLine();
          }
          output.push(eatComment());
          print.newLine();
          if (header) {
            print.newLine(true);
          }
        } else if (ch === '/' && peek() === '/') {
          if (!isAfterNewline && last_top_ch !== '{') {
            print.trim();
          }
          print.singleSpace();
          output.push(eatComment());
          print.newLine();
        } else if (ch === '@') {
          print.preserveSingleSpace();
          output.push(ch);
          var variableOrRule = peekString(": ,;{}()[]/='\"");
          if (variableOrRule.match(/[ :]$/)) {
            next();
            variableOrRule = eatString(": ").replace(/\s$/, '');
            output.push(variableOrRule);
            print.singleSpace();
          }
          variableOrRule = variableOrRule.replace(/\s$/, '');
          if (variableOrRule in css_beautify.NESTED_AT_RULE) {
            nestedLevel += 1;
            if (variableOrRule in css_beautify.CONDITIONAL_GROUP_RULE) {
              enteringConditionalGroup = true;
            }
          }
        } else if (ch === '#' && peek() === '{') {
          print.preserveSingleSpace();
          output.push(eatString('}'));
        } else if (ch === '{') {
          if (peek(true) === '}') {
            eatWhitespace();
            next();
            print.singleSpace();
            output.push("{}");
            print.newLine();
            if (newline_between_rules && indentLevel === 0) {
              print.newLine(true);
            }
          } else {
            indent();
            print["{"](ch);
            if (enteringConditionalGroup) {
              enteringConditionalGroup = false;
              insideRule = (indentLevel > nestedLevel);
            } else {
              insideRule = (indentLevel >= nestedLevel);
            }
          }
        } else if (ch === '}') {
          outdent();
          print["}"](ch);
          insideRule = false;
          insidePropertyValue = false;
          if (nestedLevel) {
            nestedLevel--;
          }
          if (newline_between_rules && indentLevel === 0) {
            print.newLine(true);
          }
        } else if (ch === ":") {
          eatWhitespace();
          if ((insideRule || enteringConditionalGroup) && !(lookBack("&") || foundNestedPseudoClass())) {
            insidePropertyValue = true;
            output.push(':');
            print.singleSpace();
          } else {
            if (peek() === ":") {
              next();
              output.push("::");
            } else {
              output.push(':');
            }
          }
        } else if (ch === '"' || ch === '\'') {
          print.preserveSingleSpace();
          output.push(eatString(ch));
        } else if (ch === ';') {
          insidePropertyValue = false;
          output.push(ch);
          print.newLine();
        } else if (ch === '(') {
          if (lookBack("url")) {
            output.push(ch);
            eatWhitespace();
            if (next()) {
              if (ch !== ')' && ch !== '"' && ch !== '\'') {
                output.push(eatString(')'));
              } else {
                pos--;
              }
            }
          } else {
            parenLevel++;
            print.preserveSingleSpace();
            output.push(ch);
            eatWhitespace();
          }
        } else if (ch === ')') {
          output.push(ch);
          parenLevel--;
        } else if (ch === ',') {
          output.push(ch);
          eatWhitespace();
          if (selectorSeparatorNewline && !insidePropertyValue && parenLevel < 1) {
            print.newLine();
          } else {
            print.singleSpace();
          }
        } else if (ch === ']') {
          output.push(ch);
        } else if (ch === '[') {
          print.preserveSingleSpace();
          output.push(ch);
        } else if (ch === '=') {
          eatWhitespace();
          ch = '=';
          output.push(ch);
        } else {
          print.preserveSingleSpace();
          output.push(ch);
        }
      }
      var sweetCode = '';
      if (basebaseIndentString) {
        sweetCode += basebaseIndentString;
      }
      sweetCode += output.join('').replace(/[\r\n\t ]+$/, '');
      if (end_with_newline) {
        sweetCode += '\n';
      }
      if (eol != '\n') {
        sweetCode = sweetCode.replace(/[\n]/g, eol);
      }
      return sweetCode;
    }
    css_beautify.NESTED_AT_RULE = {
      "@page": true,
      "@font-face": true,
      "@keyframes": true,
      "@media": true,
      "@supports": true,
      "@document": true
    };
    css_beautify.CONDITIONAL_GROUP_RULE = {
      "@media": true,
      "@supports": true,
      "@document": true
    };
    if (typeof define === "function" && define.amd) {
      define([], function() {
        return {css_beautify: css_beautify};
      });
    } else if (typeof exports !== "undefined") {
      exports.css_beautify = css_beautify;
    } else if (typeof window !== "undefined") {
      window.css_beautify = css_beautify;
    } else if (typeof global !== "undefined") {
      global.css_beautify = css_beautify;
    }
  }());
  global.define = __define;
  return module.exports;
});

System.register("npm:js-beautify@1.5.10/js/lib/beautify-html", ["npm:js-beautify@1.5.10/js/lib/beautify", "npm:js-beautify@1.5.10/js/lib/beautify-css"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  "format cjs";
  (function() {
    function trim(s) {
      return s.replace(/^\s+|\s+$/g, '');
    }
    function ltrim(s) {
      return s.replace(/^\s+/g, '');
    }
    function rtrim(s) {
      return s.replace(/\s+$/g, '');
    }
    function style_html(html_source, options, js_beautify, css_beautify) {
      var multi_parser,
          indent_inner_html,
          indent_size,
          indent_character,
          wrap_line_length,
          brace_style,
          unformatted,
          preserve_newlines,
          max_preserve_newlines,
          indent_handlebars,
          wrap_attributes,
          wrap_attributes_indent_size,
          end_with_newline,
          extra_liners,
          eol;
      options = options || {};
      if ((options.wrap_line_length === undefined || parseInt(options.wrap_line_length, 10) === 0) && (options.max_char !== undefined && parseInt(options.max_char, 10) !== 0)) {
        options.wrap_line_length = options.max_char;
      }
      indent_inner_html = (options.indent_inner_html === undefined) ? false : options.indent_inner_html;
      indent_size = (options.indent_size === undefined) ? 4 : parseInt(options.indent_size, 10);
      indent_character = (options.indent_char === undefined) ? ' ' : options.indent_char;
      brace_style = (options.brace_style === undefined) ? 'collapse' : options.brace_style;
      wrap_line_length = parseInt(options.wrap_line_length, 10) === 0 ? 32786 : parseInt(options.wrap_line_length || 250, 10);
      unformatted = options.unformatted || ['a', 'span', 'img', 'bdo', 'em', 'strong', 'dfn', 'code', 'samp', 'kbd', 'var', 'cite', 'abbr', 'acronym', 'q', 'sub', 'sup', 'tt', 'i', 'b', 'big', 'small', 'u', 's', 'strike', 'font', 'ins', 'del', 'pre', 'address', 'dt', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'];
      preserve_newlines = (options.preserve_newlines === undefined) ? true : options.preserve_newlines;
      max_preserve_newlines = preserve_newlines ? (isNaN(parseInt(options.max_preserve_newlines, 10)) ? 32786 : parseInt(options.max_preserve_newlines, 10)) : 0;
      indent_handlebars = (options.indent_handlebars === undefined) ? false : options.indent_handlebars;
      wrap_attributes = (options.wrap_attributes === undefined) ? 'auto' : options.wrap_attributes;
      wrap_attributes_indent_size = (options.wrap_attributes_indent_size === undefined) ? indent_size : parseInt(options.wrap_attributes_indent_size, 10) || indent_size;
      end_with_newline = (options.end_with_newline === undefined) ? false : options.end_with_newline;
      extra_liners = (typeof options.extra_liners == 'object') && options.extra_liners ? options.extra_liners.concat() : (typeof options.extra_liners === 'string') ? options.extra_liners.split(',') : 'head,body,/html'.split(',');
      eol = options.eol ? options.eol : '\n';
      if (options.indent_with_tabs) {
        indent_character = '\t';
        indent_size = 1;
      }
      eol = eol.replace(/\\r/, '\r').replace(/\\n/, '\n');
      function Parser() {
        this.pos = 0;
        this.token = '';
        this.current_mode = 'CONTENT';
        this.tags = {
          parent: 'parent1',
          parentcount: 1,
          parent1: ''
        };
        this.tag_type = '';
        this.token_text = this.last_token = this.last_text = this.token_type = '';
        this.newlines = 0;
        this.indent_content = indent_inner_html;
        this.Utils = {
          whitespace: "\n\r\t ".split(''),
          single_token: 'br,input,link,meta,source,!doctype,basefont,base,area,hr,wbr,param,img,isindex,embed'.split(','),
          extra_liners: extra_liners,
          in_array: function(what, arr) {
            for (var i = 0; i < arr.length; i++) {
              if (what === arr[i]) {
                return true;
              }
            }
            return false;
          }
        };
        this.is_whitespace = function(text) {
          for (var n = 0; n < text.length; text++) {
            if (!this.Utils.in_array(text.charAt(n), this.Utils.whitespace)) {
              return false;
            }
          }
          return true;
        };
        this.traverse_whitespace = function() {
          var input_char = '';
          input_char = this.input.charAt(this.pos);
          if (this.Utils.in_array(input_char, this.Utils.whitespace)) {
            this.newlines = 0;
            while (this.Utils.in_array(input_char, this.Utils.whitespace)) {
              if (preserve_newlines && input_char === '\n' && this.newlines <= max_preserve_newlines) {
                this.newlines += 1;
              }
              this.pos++;
              input_char = this.input.charAt(this.pos);
            }
            return true;
          }
          return false;
        };
        this.space_or_wrap = function(content) {
          if (this.line_char_count >= this.wrap_line_length) {
            this.print_newline(false, content);
            this.print_indentation(content);
          } else {
            this.line_char_count++;
            content.push(' ');
          }
        };
        this.get_content = function() {
          var input_char = '',
              content = [],
              space = false;
          while (this.input.charAt(this.pos) !== '<') {
            if (this.pos >= this.input.length) {
              return content.length ? content.join('') : ['', 'TK_EOF'];
            }
            if (this.traverse_whitespace()) {
              this.space_or_wrap(content);
              continue;
            }
            if (indent_handlebars) {
              var peek3 = this.input.substr(this.pos, 3);
              if (peek3 === '{{#' || peek3 === '{{/') {
                break;
              } else if (peek3 === '{{!') {
                return [this.get_tag(), 'TK_TAG_HANDLEBARS_COMMENT'];
              } else if (this.input.substr(this.pos, 2) === '{{') {
                if (this.get_tag(true) === '{{else}}') {
                  break;
                }
              }
            }
            input_char = this.input.charAt(this.pos);
            this.pos++;
            this.line_char_count++;
            content.push(input_char);
          }
          return content.length ? content.join('') : '';
        };
        this.get_contents_to = function(name) {
          if (this.pos === this.input.length) {
            return ['', 'TK_EOF'];
          }
          var input_char = '';
          var content = '';
          var reg_match = new RegExp('</' + name + '\\s*>', 'igm');
          reg_match.lastIndex = this.pos;
          var reg_array = reg_match.exec(this.input);
          var end_script = reg_array ? reg_array.index : this.input.length;
          if (this.pos < end_script) {
            content = this.input.substring(this.pos, end_script);
            this.pos = end_script;
          }
          return content;
        };
        this.record_tag = function(tag) {
          if (this.tags[tag + 'count']) {
            this.tags[tag + 'count']++;
            this.tags[tag + this.tags[tag + 'count']] = this.indent_level;
          } else {
            this.tags[tag + 'count'] = 1;
            this.tags[tag + this.tags[tag + 'count']] = this.indent_level;
          }
          this.tags[tag + this.tags[tag + 'count'] + 'parent'] = this.tags.parent;
          this.tags.parent = tag + this.tags[tag + 'count'];
        };
        this.retrieve_tag = function(tag) {
          if (this.tags[tag + 'count']) {
            var temp_parent = this.tags.parent;
            while (temp_parent) {
              if (tag + this.tags[tag + 'count'] === temp_parent) {
                break;
              }
              temp_parent = this.tags[temp_parent + 'parent'];
            }
            if (temp_parent) {
              this.indent_level = this.tags[tag + this.tags[tag + 'count']];
              this.tags.parent = this.tags[temp_parent + 'parent'];
            }
            delete this.tags[tag + this.tags[tag + 'count'] + 'parent'];
            delete this.tags[tag + this.tags[tag + 'count']];
            if (this.tags[tag + 'count'] === 1) {
              delete this.tags[tag + 'count'];
            } else {
              this.tags[tag + 'count']--;
            }
          }
        };
        this.indent_to_tag = function(tag) {
          if (!this.tags[tag + 'count']) {
            return ;
          }
          var temp_parent = this.tags.parent;
          while (temp_parent) {
            if (tag + this.tags[tag + 'count'] === temp_parent) {
              break;
            }
            temp_parent = this.tags[temp_parent + 'parent'];
          }
          if (temp_parent) {
            this.indent_level = this.tags[tag + this.tags[tag + 'count']];
          }
        };
        this.get_tag = function(peek) {
          var input_char = '',
              content = [],
              comment = '',
              space = false,
              first_attr = true,
              tag_start,
              tag_end,
              tag_start_char,
              orig_pos = this.pos,
              orig_line_char_count = this.line_char_count;
          peek = peek !== undefined ? peek : false;
          do {
            if (this.pos >= this.input.length) {
              if (peek) {
                this.pos = orig_pos;
                this.line_char_count = orig_line_char_count;
              }
              return content.length ? content.join('') : ['', 'TK_EOF'];
            }
            input_char = this.input.charAt(this.pos);
            this.pos++;
            if (this.Utils.in_array(input_char, this.Utils.whitespace)) {
              space = true;
              continue;
            }
            if (input_char === "'" || input_char === '"') {
              input_char += this.get_unformatted(input_char);
              space = true;
            }
            if (input_char === '=') {
              space = false;
            }
            if (content.length && content[content.length - 1] !== '=' && input_char !== '>' && space) {
              this.space_or_wrap(content);
              space = false;
              if (!first_attr && wrap_attributes === 'force' && input_char !== '/') {
                this.print_newline(true, content);
                this.print_indentation(content);
                for (var count = 0; count < wrap_attributes_indent_size; count++) {
                  content.push(indent_character);
                }
              }
              for (var i = 0; i < content.length; i++) {
                if (content[i] === ' ') {
                  first_attr = false;
                  break;
                }
              }
            }
            if (indent_handlebars && tag_start_char === '<') {
              if ((input_char + this.input.charAt(this.pos)) === '{{') {
                input_char += this.get_unformatted('}}');
                if (content.length && content[content.length - 1] !== ' ' && content[content.length - 1] !== '<') {
                  input_char = ' ' + input_char;
                }
                space = true;
              }
            }
            if (input_char === '<' && !tag_start_char) {
              tag_start = this.pos - 1;
              tag_start_char = '<';
            }
            if (indent_handlebars && !tag_start_char) {
              if (content.length >= 2 && content[content.length - 1] === '{' && content[content.length - 2] === '{') {
                if (input_char === '#' || input_char === '/' || input_char === '!') {
                  tag_start = this.pos - 3;
                } else {
                  tag_start = this.pos - 2;
                }
                tag_start_char = '{';
              }
            }
            this.line_char_count++;
            content.push(input_char);
            if (content[1] && (content[1] === '!' || content[1] === '?' || content[1] === '%')) {
              content = [this.get_comment(tag_start)];
              break;
            }
            if (indent_handlebars && content[1] && content[1] === '{' && content[2] && content[2] === '!') {
              content = [this.get_comment(tag_start)];
              break;
            }
            if (indent_handlebars && tag_start_char === '{' && content.length > 2 && content[content.length - 2] === '}' && content[content.length - 1] === '}') {
              break;
            }
          } while (input_char !== '>');
          var tag_complete = content.join('');
          var tag_index;
          var tag_offset;
          if (tag_complete.indexOf(' ') !== -1) {
            tag_index = tag_complete.indexOf(' ');
          } else if (tag_complete.charAt(0) === '{') {
            tag_index = tag_complete.indexOf('}');
          } else {
            tag_index = tag_complete.indexOf('>');
          }
          if (tag_complete.charAt(0) === '<' || !indent_handlebars) {
            tag_offset = 1;
          } else {
            tag_offset = tag_complete.charAt(2) === '#' ? 3 : 2;
          }
          var tag_check = tag_complete.substring(tag_offset, tag_index).toLowerCase();
          if (tag_complete.charAt(tag_complete.length - 2) === '/' || this.Utils.in_array(tag_check, this.Utils.single_token)) {
            if (!peek) {
              this.tag_type = 'SINGLE';
            }
          } else if (indent_handlebars && tag_complete.charAt(0) === '{' && tag_check === 'else') {
            if (!peek) {
              this.indent_to_tag('if');
              this.tag_type = 'HANDLEBARS_ELSE';
              this.indent_content = true;
              this.traverse_whitespace();
            }
          } else if (this.is_unformatted(tag_check, unformatted)) {
            comment = this.get_unformatted('</' + tag_check + '>', tag_complete);
            content.push(comment);
            tag_end = this.pos - 1;
            this.tag_type = 'SINGLE';
          } else if (tag_check === 'script' && (tag_complete.search('type') === -1 || (tag_complete.search('type') > -1 && tag_complete.search(/\b(text|application)\/(x-)?(javascript|ecmascript|jscript|livescript)/) > -1))) {
            if (!peek) {
              this.record_tag(tag_check);
              this.tag_type = 'SCRIPT';
            }
          } else if (tag_check === 'style' && (tag_complete.search('type') === -1 || (tag_complete.search('type') > -1 && tag_complete.search('text/css') > -1))) {
            if (!peek) {
              this.record_tag(tag_check);
              this.tag_type = 'STYLE';
            }
          } else if (tag_check.charAt(0) === '!') {
            if (!peek) {
              this.tag_type = 'SINGLE';
              this.traverse_whitespace();
            }
          } else if (!peek) {
            if (tag_check.charAt(0) === '/') {
              this.retrieve_tag(tag_check.substring(1));
              this.tag_type = 'END';
            } else {
              this.record_tag(tag_check);
              if (tag_check.toLowerCase() !== 'html') {
                this.indent_content = true;
              }
              this.tag_type = 'START';
            }
            if (this.traverse_whitespace()) {
              this.space_or_wrap(content);
            }
            if (this.Utils.in_array(tag_check, this.Utils.extra_liners)) {
              this.print_newline(false, this.output);
              if (this.output.length && this.output[this.output.length - 2] !== '\n') {
                this.print_newline(true, this.output);
              }
            }
          }
          if (peek) {
            this.pos = orig_pos;
            this.line_char_count = orig_line_char_count;
          }
          return content.join('');
        };
        this.get_comment = function(start_pos) {
          var comment = '',
              delimiter = '>',
              matched = false;
          this.pos = start_pos;
          input_char = this.input.charAt(this.pos);
          this.pos++;
          while (this.pos <= this.input.length) {
            comment += input_char;
            if (comment.charAt(comment.length - 1) === delimiter.charAt(delimiter.length - 1) && comment.indexOf(delimiter) !== -1) {
              break;
            }
            if (!matched && comment.length < 10) {
              if (comment.indexOf('<![if') === 0) {
                delimiter = '<![endif]>';
                matched = true;
              } else if (comment.indexOf('<![cdata[') === 0) {
                delimiter = ']]>';
                matched = true;
              } else if (comment.indexOf('<![') === 0) {
                delimiter = ']>';
                matched = true;
              } else if (comment.indexOf('<!--') === 0) {
                delimiter = '-->';
                matched = true;
              } else if (comment.indexOf('{{!') === 0) {
                delimiter = '}}';
                matched = true;
              } else if (comment.indexOf('<?') === 0) {
                delimiter = '?>';
                matched = true;
              } else if (comment.indexOf('<%') === 0) {
                delimiter = '%>';
                matched = true;
              }
            }
            input_char = this.input.charAt(this.pos);
            this.pos++;
          }
          return comment;
        };
        this.get_unformatted = function(delimiter, orig_tag) {
          if (orig_tag && orig_tag.toLowerCase().indexOf(delimiter) !== -1) {
            return '';
          }
          var input_char = '';
          var content = '';
          var min_index = 0;
          var space = true;
          do {
            if (this.pos >= this.input.length) {
              return content;
            }
            input_char = this.input.charAt(this.pos);
            this.pos++;
            if (this.Utils.in_array(input_char, this.Utils.whitespace)) {
              if (!space) {
                this.line_char_count--;
                continue;
              }
              if (input_char === '\n' || input_char === '\r') {
                content += '\n';
                this.line_char_count = 0;
                continue;
              }
            }
            content += input_char;
            this.line_char_count++;
            space = true;
            if (indent_handlebars && input_char === '{' && content.length && content.charAt(content.length - 2) === '{') {
              content += this.get_unformatted('}}');
              min_index = content.length;
            }
          } while (content.toLowerCase().indexOf(delimiter, min_index) === -1);
          return content;
        };
        this.get_token = function() {
          var token;
          if (this.last_token === 'TK_TAG_SCRIPT' || this.last_token === 'TK_TAG_STYLE') {
            var type = this.last_token.substr(7);
            token = this.get_contents_to(type);
            if (typeof token !== 'string') {
              return token;
            }
            return [token, 'TK_' + type];
          }
          if (this.current_mode === 'CONTENT') {
            token = this.get_content();
            if (typeof token !== 'string') {
              return token;
            } else {
              return [token, 'TK_CONTENT'];
            }
          }
          if (this.current_mode === 'TAG') {
            token = this.get_tag();
            if (typeof token !== 'string') {
              return token;
            } else {
              var tag_name_type = 'TK_TAG_' + this.tag_type;
              return [token, tag_name_type];
            }
          }
        };
        this.get_full_indent = function(level) {
          level = this.indent_level + level || 0;
          if (level < 1) {
            return '';
          }
          return Array(level + 1).join(this.indent_string);
        };
        this.is_unformatted = function(tag_check, unformatted) {
          if (!this.Utils.in_array(tag_check, unformatted)) {
            return false;
          }
          if (tag_check.toLowerCase() !== 'a' || !this.Utils.in_array('a', unformatted)) {
            return true;
          }
          var next_tag = this.get_tag(true);
          var tag = (next_tag || "").match(/^\s*<\s*\/?([a-z]*)\s*[^>]*>\s*$/);
          if (!tag || this.Utils.in_array(tag, unformatted)) {
            return true;
          } else {
            return false;
          }
        };
        this.printer = function(js_source, indent_character, indent_size, wrap_line_length, brace_style) {
          this.input = js_source || '';
          this.input = this.input.replace(/\r\n|[\r\u2028\u2029]/g, '\n');
          this.output = [];
          this.indent_character = indent_character;
          this.indent_string = '';
          this.indent_size = indent_size;
          this.brace_style = brace_style;
          this.indent_level = 0;
          this.wrap_line_length = wrap_line_length;
          this.line_char_count = 0;
          for (var i = 0; i < this.indent_size; i++) {
            this.indent_string += this.indent_character;
          }
          this.print_newline = function(force, arr) {
            this.line_char_count = 0;
            if (!arr || !arr.length) {
              return ;
            }
            if (force || (arr[arr.length - 1] !== '\n')) {
              if ((arr[arr.length - 1] !== '\n')) {
                arr[arr.length - 1] = rtrim(arr[arr.length - 1]);
              }
              arr.push('\n');
            }
          };
          this.print_indentation = function(arr) {
            for (var i = 0; i < this.indent_level; i++) {
              arr.push(this.indent_string);
              this.line_char_count += this.indent_string.length;
            }
          };
          this.print_token = function(text) {
            if (this.is_whitespace(text) && !this.output.length) {
              return ;
            }
            if (text || text !== '') {
              if (this.output.length && this.output[this.output.length - 1] === '\n') {
                this.print_indentation(this.output);
                text = ltrim(text);
              }
            }
            this.print_token_raw(text);
          };
          this.print_token_raw = function(text) {
            if (this.newlines > 0) {
              text = rtrim(text);
            }
            if (text && text !== '') {
              if (text.length > 1 && text.charAt(text.length - 1) === '\n') {
                this.output.push(text.slice(0, -1));
                this.print_newline(false, this.output);
              } else {
                this.output.push(text);
              }
            }
            for (var n = 0; n < this.newlines; n++) {
              this.print_newline(n > 0, this.output);
            }
            this.newlines = 0;
          };
          this.indent = function() {
            this.indent_level++;
          };
          this.unindent = function() {
            if (this.indent_level > 0) {
              this.indent_level--;
            }
          };
        };
        return this;
      }
      multi_parser = new Parser();
      multi_parser.printer(html_source, indent_character, indent_size, wrap_line_length, brace_style);
      while (true) {
        var t = multi_parser.get_token();
        multi_parser.token_text = t[0];
        multi_parser.token_type = t[1];
        if (multi_parser.token_type === 'TK_EOF') {
          break;
        }
        switch (multi_parser.token_type) {
          case 'TK_TAG_START':
            multi_parser.print_newline(false, multi_parser.output);
            multi_parser.print_token(multi_parser.token_text);
            if (multi_parser.indent_content) {
              multi_parser.indent();
              multi_parser.indent_content = false;
            }
            multi_parser.current_mode = 'CONTENT';
            break;
          case 'TK_TAG_STYLE':
          case 'TK_TAG_SCRIPT':
            multi_parser.print_newline(false, multi_parser.output);
            multi_parser.print_token(multi_parser.token_text);
            multi_parser.current_mode = 'CONTENT';
            break;
          case 'TK_TAG_END':
            if (multi_parser.last_token === 'TK_CONTENT' && multi_parser.last_text === '') {
              var tag_name = multi_parser.token_text.match(/\w+/)[0];
              var tag_extracted_from_last_output = null;
              if (multi_parser.output.length) {
                tag_extracted_from_last_output = multi_parser.output[multi_parser.output.length - 1].match(/(?:<|{{#)\s*(\w+)/);
              }
              if (tag_extracted_from_last_output === null || (tag_extracted_from_last_output[1] !== tag_name && !multi_parser.Utils.in_array(tag_extracted_from_last_output[1], unformatted))) {
                multi_parser.print_newline(false, multi_parser.output);
              }
            }
            multi_parser.print_token(multi_parser.token_text);
            multi_parser.current_mode = 'CONTENT';
            break;
          case 'TK_TAG_SINGLE':
            var tag_check = multi_parser.token_text.match(/^\s*<([a-z-]+)/i);
            if (!tag_check || !multi_parser.Utils.in_array(tag_check[1], unformatted)) {
              multi_parser.print_newline(false, multi_parser.output);
            }
            multi_parser.print_token(multi_parser.token_text);
            multi_parser.current_mode = 'CONTENT';
            break;
          case 'TK_TAG_HANDLEBARS_ELSE':
            multi_parser.print_token(multi_parser.token_text);
            if (multi_parser.indent_content) {
              multi_parser.indent();
              multi_parser.indent_content = false;
            }
            multi_parser.current_mode = 'CONTENT';
            break;
          case 'TK_TAG_HANDLEBARS_COMMENT':
            multi_parser.print_token(multi_parser.token_text);
            multi_parser.current_mode = 'TAG';
            break;
          case 'TK_CONTENT':
            multi_parser.print_token(multi_parser.token_text);
            multi_parser.current_mode = 'TAG';
            break;
          case 'TK_STYLE':
          case 'TK_SCRIPT':
            if (multi_parser.token_text !== '') {
              multi_parser.print_newline(false, multi_parser.output);
              var text = multi_parser.token_text,
                  _beautifier,
                  script_indent_level = 1;
              if (multi_parser.token_type === 'TK_SCRIPT') {
                _beautifier = typeof js_beautify === 'function' && js_beautify;
              } else if (multi_parser.token_type === 'TK_STYLE') {
                _beautifier = typeof css_beautify === 'function' && css_beautify;
              }
              if (options.indent_scripts === "keep") {
                script_indent_level = 0;
              } else if (options.indent_scripts === "separate") {
                script_indent_level = -multi_parser.indent_level;
              }
              var indentation = multi_parser.get_full_indent(script_indent_level);
              if (_beautifier) {
                var Child_options = function() {
                  this.eol = '\n';
                };
                Child_options.prototype = options;
                var child_options = new Child_options();
                text = _beautifier(text.replace(/^\s*/, indentation), child_options);
              } else {
                var white = text.match(/^\s*/)[0];
                var _level = white.match(/[^\n\r]*$/)[0].split(multi_parser.indent_string).length - 1;
                var reindent = multi_parser.get_full_indent(script_indent_level - _level);
                text = text.replace(/^\s*/, indentation).replace(/\r\n|\r|\n/g, '\n' + reindent).replace(/\s+$/, '');
              }
              if (text) {
                multi_parser.print_token_raw(text);
                multi_parser.print_newline(true, multi_parser.output);
              }
            }
            multi_parser.current_mode = 'TAG';
            break;
          default:
            if (multi_parser.token_text !== '') {
              multi_parser.print_token(multi_parser.token_text);
            }
            break;
        }
        multi_parser.last_token = multi_parser.token_type;
        multi_parser.last_text = multi_parser.token_text;
      }
      var sweet_code = multi_parser.output.join('').replace(/[\r\n\t ]+$/, '');
      if (end_with_newline) {
        sweet_code += '\n';
      }
      if (eol != '\n') {
        sweet_code = sweet_code.replace(/[\n]/g, eol);
      }
      return sweet_code;
    }
    if (typeof define === "function" && define.amd) {
      define(["require", "./beautify", "./beautify-css"], function(requireamd) {
        var js_beautify = requireamd("./beautify");
        var css_beautify = requireamd("./beautify-css");
        return {html_beautify: function(html_source, options) {
            return style_html(html_source, options, js_beautify.js_beautify, css_beautify.css_beautify);
          }};
      });
    } else if (typeof exports !== "undefined") {
      var js_beautify = require("npm:js-beautify@1.5.10/js/lib/beautify");
      var css_beautify = require("npm:js-beautify@1.5.10/js/lib/beautify-css");
      exports.html_beautify = function(html_source, options) {
        return style_html(html_source, options, js_beautify.js_beautify, css_beautify.css_beautify);
      };
    } else if (typeof window !== "undefined") {
      window.html_beautify = function(html_source, options) {
        return style_html(html_source, options, window.js_beautify, window.css_beautify);
      };
    } else if (typeof global !== "undefined") {
      global.html_beautify = function(html_source, options) {
        return style_html(html_source, options, global.js_beautify, global.css_beautify);
      };
    }
  }());
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.18/library/fn/object/define-properties", ["npm:core-js@0.9.18/library/modules/$"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var $ = require("npm:core-js@0.9.18/library/modules/$");
  module.exports = function defineProperties(T, D) {
    return $.setDescs(T, D);
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.18/library/modules/$", ["npm:core-js@0.9.18/library/modules/$.fw"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var global = typeof self != 'undefined' ? self : Function('return this')(),
      core = {},
      defineProperty = Object.defineProperty,
      hasOwnProperty = {}.hasOwnProperty,
      ceil = Math.ceil,
      floor = Math.floor,
      max = Math.max,
      min = Math.min;
  var DESC = !!function() {
    try {
      return defineProperty({}, 'a', {get: function() {
          return 2;
        }}).a == 2;
    } catch (e) {}
  }();
  var hide = createDefiner(1);
  function toInteger(it) {
    return isNaN(it = +it) ? 0 : (it > 0 ? floor : ceil)(it);
  }
  function desc(bitmap, value) {
    return {
      enumerable: !(bitmap & 1),
      configurable: !(bitmap & 2),
      writable: !(bitmap & 4),
      value: value
    };
  }
  function simpleSet(object, key, value) {
    object[key] = value;
    return object;
  }
  function createDefiner(bitmap) {
    return DESC ? function(object, key, value) {
      return $.setDesc(object, key, desc(bitmap, value));
    } : simpleSet;
  }
  function isObject(it) {
    return it !== null && (typeof it == 'object' || typeof it == 'function');
  }
  function isFunction(it) {
    return typeof it == 'function';
  }
  function assertDefined(it) {
    if (it == undefined)
      throw TypeError("Can't call method on  " + it);
    return it;
  }
  var $ = module.exports = require("npm:core-js@0.9.18/library/modules/$.fw")({
    g: global,
    core: core,
    html: global.document && document.documentElement,
    isObject: isObject,
    isFunction: isFunction,
    that: function() {
      return this;
    },
    toInteger: toInteger,
    toLength: function(it) {
      return it > 0 ? min(toInteger(it), 0x1fffffffffffff) : 0;
    },
    toIndex: function(index, length) {
      index = toInteger(index);
      return index < 0 ? max(index + length, 0) : min(index, length);
    },
    has: function(it, key) {
      return hasOwnProperty.call(it, key);
    },
    create: Object.create,
    getProto: Object.getPrototypeOf,
    DESC: DESC,
    desc: desc,
    getDesc: Object.getOwnPropertyDescriptor,
    setDesc: defineProperty,
    setDescs: Object.defineProperties,
    getKeys: Object.keys,
    getNames: Object.getOwnPropertyNames,
    getSymbols: Object.getOwnPropertySymbols,
    assertDefined: assertDefined,
    ES5Object: Object,
    toObject: function(it) {
      return $.ES5Object(assertDefined(it));
    },
    hide: hide,
    def: createDefiner(0),
    set: global.Symbol ? simpleSet : hide,
    each: [].forEach
  });
  if (typeof __e != 'undefined')
    __e = core;
  if (typeof __g != 'undefined')
    __g = global;
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.18/library/modules/$.assign", ["npm:core-js@0.9.18/library/modules/$", "npm:core-js@0.9.18/library/modules/$.enum-keys"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var $ = require("npm:core-js@0.9.18/library/modules/$"),
      enumKeys = require("npm:core-js@0.9.18/library/modules/$.enum-keys");
  module.exports = Object.assign || function assign(target, source) {
    var T = Object($.assertDefined(target)),
        l = arguments.length,
        i = 1;
    while (l > i) {
      var S = $.ES5Object(arguments[i++]),
          keys = enumKeys(S),
          length = keys.length,
          j = 0,
          key;
      while (length > j)
        T[key = keys[j++]] = S[key];
    }
    return T;
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.18/library/modules/$.wks", ["npm:core-js@0.9.18/library/modules/$", "npm:core-js@0.9.18/library/modules/$.shared", "npm:core-js@0.9.18/library/modules/$.uid"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var global = require("npm:core-js@0.9.18/library/modules/$").g,
      store = require("npm:core-js@0.9.18/library/modules/$.shared")('wks');
  module.exports = function(name) {
    return store[name] || (store[name] = global.Symbol && global.Symbol[name] || require("npm:core-js@0.9.18/library/modules/$.uid").safe('Symbol.' + name));
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.18/library/modules/$.iter-define", ["npm:core-js@0.9.18/library/modules/$.def", "npm:core-js@0.9.18/library/modules/$.redef", "npm:core-js@0.9.18/library/modules/$", "npm:core-js@0.9.18/library/modules/$.cof", "npm:core-js@0.9.18/library/modules/$.iter", "npm:core-js@0.9.18/library/modules/$.wks"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var $def = require("npm:core-js@0.9.18/library/modules/$.def"),
      $redef = require("npm:core-js@0.9.18/library/modules/$.redef"),
      $ = require("npm:core-js@0.9.18/library/modules/$"),
      cof = require("npm:core-js@0.9.18/library/modules/$.cof"),
      $iter = require("npm:core-js@0.9.18/library/modules/$.iter"),
      SYMBOL_ITERATOR = require("npm:core-js@0.9.18/library/modules/$.wks")('iterator'),
      FF_ITERATOR = '@@iterator',
      KEYS = 'keys',
      VALUES = 'values',
      Iterators = $iter.Iterators;
  module.exports = function(Base, NAME, Constructor, next, DEFAULT, IS_SET, FORCE) {
    $iter.create(Constructor, NAME, next);
    function createMethod(kind) {
      function $$(that) {
        return new Constructor(that, kind);
      }
      switch (kind) {
        case KEYS:
          return function keys() {
            return $$(this);
          };
        case VALUES:
          return function values() {
            return $$(this);
          };
      }
      return function entries() {
        return $$(this);
      };
    }
    var TAG = NAME + ' Iterator',
        proto = Base.prototype,
        _native = proto[SYMBOL_ITERATOR] || proto[FF_ITERATOR] || DEFAULT && proto[DEFAULT],
        _default = _native || createMethod(DEFAULT),
        methods,
        key;
    if (_native) {
      var IteratorPrototype = $.getProto(_default.call(new Base));
      cof.set(IteratorPrototype, TAG, true);
      if ($.FW && $.has(proto, FF_ITERATOR))
        $iter.set(IteratorPrototype, $.that);
    }
    if ($.FW || FORCE)
      $iter.set(proto, _default);
    Iterators[NAME] = _default;
    Iterators[TAG] = $.that;
    if (DEFAULT) {
      methods = {
        keys: IS_SET ? _default : createMethod(KEYS),
        values: DEFAULT == VALUES ? _default : createMethod(VALUES),
        entries: DEFAULT != VALUES ? _default : createMethod('entries')
      };
      if (FORCE)
        for (key in methods) {
          if (!(key in proto))
            $redef(proto, key, methods[key]);
        }
      else
        $def($def.P + $def.F * $iter.BUGGY, NAME, methods);
    }
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.18/library/modules/es6.array.from", ["npm:core-js@0.9.18/library/modules/$", "npm:core-js@0.9.18/library/modules/$.ctx", "npm:core-js@0.9.18/library/modules/$.def", "npm:core-js@0.9.18/library/modules/$.iter", "npm:core-js@0.9.18/library/modules/$.iter-call", "npm:core-js@0.9.18/library/modules/$.iter-detect"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var $ = require("npm:core-js@0.9.18/library/modules/$"),
      ctx = require("npm:core-js@0.9.18/library/modules/$.ctx"),
      $def = require("npm:core-js@0.9.18/library/modules/$.def"),
      $iter = require("npm:core-js@0.9.18/library/modules/$.iter"),
      call = require("npm:core-js@0.9.18/library/modules/$.iter-call");
  $def($def.S + $def.F * !require("npm:core-js@0.9.18/library/modules/$.iter-detect")(function(iter) {
    Array.from(iter);
  }), 'Array', {from: function from(arrayLike) {
      var O = Object($.assertDefined(arrayLike)),
          mapfn = arguments[1],
          mapping = mapfn !== undefined,
          f = mapping ? ctx(mapfn, arguments[2], 2) : undefined,
          index = 0,
          length,
          result,
          step,
          iterator;
      if ($iter.is(O)) {
        iterator = $iter.get(O);
        result = new (typeof this == 'function' ? this : Array);
        for (; !(step = iterator.next()).done; index++) {
          result[index] = mapping ? call(iterator, f, [step.value, index], true) : step.value;
        }
      } else {
        result = new (typeof this == 'function' ? this : Array)(length = $.toLength(O.length));
        for (; length > index; index++) {
          result[index] = mapping ? f(O[index], index) : O[index];
        }
      }
      result.length = index;
      return result;
    }});
  global.define = __define;
  return module.exports;
});

System.register("npm:babel-runtime@5.8.34/core-js/object/define-property", ["npm:core-js@0.9.18/library/fn/object/define-property"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  module.exports = {
    "default": require("npm:core-js@0.9.18/library/fn/object/define-property"),
    __esModule: true
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.18/library/modules/es6.array.iterator", ["npm:core-js@0.9.18/library/modules/$", "npm:core-js@0.9.18/library/modules/$.unscope", "npm:core-js@0.9.18/library/modules/$.uid", "npm:core-js@0.9.18/library/modules/$.iter", "npm:core-js@0.9.18/library/modules/$.iter-define"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var $ = require("npm:core-js@0.9.18/library/modules/$"),
      setUnscope = require("npm:core-js@0.9.18/library/modules/$.unscope"),
      ITER = require("npm:core-js@0.9.18/library/modules/$.uid").safe('iter'),
      $iter = require("npm:core-js@0.9.18/library/modules/$.iter"),
      step = $iter.step,
      Iterators = $iter.Iterators;
  require("npm:core-js@0.9.18/library/modules/$.iter-define")(Array, 'Array', function(iterated, kind) {
    $.set(this, ITER, {
      o: $.toObject(iterated),
      i: 0,
      k: kind
    });
  }, function() {
    var iter = this[ITER],
        O = iter.o,
        kind = iter.k,
        index = iter.i++;
    if (!O || index >= O.length) {
      iter.o = undefined;
      return step(1);
    }
    if (kind == 'keys')
      return step(0, index);
    if (kind == 'values')
      return step(0, O[index]);
    return step(0, [index, O[index]]);
  }, 'values');
  Iterators.Arguments = Iterators.Array;
  setUnscope('keys');
  setUnscope('values');
  setUnscope('entries');
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.18/library/modules/$.collection-strong", ["npm:core-js@0.9.18/library/modules/$", "npm:core-js@0.9.18/library/modules/$.ctx", "npm:core-js@0.9.18/library/modules/$.uid", "npm:core-js@0.9.18/library/modules/$.assert", "npm:core-js@0.9.18/library/modules/$.for-of", "npm:core-js@0.9.18/library/modules/$.iter", "npm:core-js@0.9.18/library/modules/$.mix", "npm:core-js@0.9.18/library/modules/$.iter-define"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var $ = require("npm:core-js@0.9.18/library/modules/$"),
      ctx = require("npm:core-js@0.9.18/library/modules/$.ctx"),
      safe = require("npm:core-js@0.9.18/library/modules/$.uid").safe,
      assert = require("npm:core-js@0.9.18/library/modules/$.assert"),
      forOf = require("npm:core-js@0.9.18/library/modules/$.for-of"),
      step = require("npm:core-js@0.9.18/library/modules/$.iter").step,
      $has = $.has,
      set = $.set,
      isObject = $.isObject,
      hide = $.hide,
      isExtensible = Object.isExtensible || isObject,
      ID = safe('id'),
      O1 = safe('O1'),
      LAST = safe('last'),
      FIRST = safe('first'),
      ITER = safe('iter'),
      SIZE = $.DESC ? safe('size') : 'size',
      id = 0;
  function fastKey(it, create) {
    if (!isObject(it))
      return typeof it == 'symbol' ? it : (typeof it == 'string' ? 'S' : 'P') + it;
    if (!$has(it, ID)) {
      if (!isExtensible(it))
        return 'F';
      if (!create)
        return 'E';
      hide(it, ID, ++id);
    }
    return 'O' + it[ID];
  }
  function getEntry(that, key) {
    var index = fastKey(key),
        entry;
    if (index !== 'F')
      return that[O1][index];
    for (entry = that[FIRST]; entry; entry = entry.n) {
      if (entry.k == key)
        return entry;
    }
  }
  module.exports = {
    getConstructor: function(wrapper, NAME, IS_MAP, ADDER) {
      var C = wrapper(function(that, iterable) {
        assert.inst(that, C, NAME);
        set(that, O1, $.create(null));
        set(that, SIZE, 0);
        set(that, LAST, undefined);
        set(that, FIRST, undefined);
        if (iterable != undefined)
          forOf(iterable, IS_MAP, that[ADDER], that);
      });
      require("npm:core-js@0.9.18/library/modules/$.mix")(C.prototype, {
        clear: function clear() {
          for (var that = this,
              data = that[O1],
              entry = that[FIRST]; entry; entry = entry.n) {
            entry.r = true;
            if (entry.p)
              entry.p = entry.p.n = undefined;
            delete data[entry.i];
          }
          that[FIRST] = that[LAST] = undefined;
          that[SIZE] = 0;
        },
        'delete': function(key) {
          var that = this,
              entry = getEntry(that, key);
          if (entry) {
            var next = entry.n,
                prev = entry.p;
            delete that[O1][entry.i];
            entry.r = true;
            if (prev)
              prev.n = next;
            if (next)
              next.p = prev;
            if (that[FIRST] == entry)
              that[FIRST] = next;
            if (that[LAST] == entry)
              that[LAST] = prev;
            that[SIZE]--;
          }
          return !!entry;
        },
        forEach: function forEach(callbackfn) {
          var f = ctx(callbackfn, arguments[1], 3),
              entry;
          while (entry = entry ? entry.n : this[FIRST]) {
            f(entry.v, entry.k, this);
            while (entry && entry.r)
              entry = entry.p;
          }
        },
        has: function has(key) {
          return !!getEntry(this, key);
        }
      });
      if ($.DESC)
        $.setDesc(C.prototype, 'size', {get: function() {
            return assert.def(this[SIZE]);
          }});
      return C;
    },
    def: function(that, key, value) {
      var entry = getEntry(that, key),
          prev,
          index;
      if (entry) {
        entry.v = value;
      } else {
        that[LAST] = entry = {
          i: index = fastKey(key, true),
          k: key,
          v: value,
          p: prev = that[LAST],
          n: undefined,
          r: false
        };
        if (!that[FIRST])
          that[FIRST] = entry;
        if (prev)
          prev.n = entry;
        that[SIZE]++;
        if (index !== 'F')
          that[O1][index] = entry;
      }
      return that;
    },
    getEntry: getEntry,
    setIter: function(C, NAME, IS_MAP) {
      require("npm:core-js@0.9.18/library/modules/$.iter-define")(C, NAME, function(iterated, kind) {
        set(this, ITER, {
          o: iterated,
          k: kind
        });
      }, function() {
        var iter = this[ITER],
            kind = iter.k,
            entry = iter.l;
        while (entry && entry.r)
          entry = entry.p;
        if (!iter.o || !(iter.l = entry = entry ? entry.n : iter.o[FIRST])) {
          iter.o = undefined;
          return step(1);
        }
        if (kind == 'keys')
          return step(0, entry.k);
        if (kind == 'values')
          return step(0, entry.v);
        return step(0, [entry.k, entry.v]);
      }, IS_MAP ? 'entries' : 'values', !IS_MAP, true);
    }
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.18/library/modules/$.collection", ["npm:core-js@0.9.18/library/modules/$", "npm:core-js@0.9.18/library/modules/$.def", "npm:core-js@0.9.18/library/modules/$.iter", "npm:core-js@0.9.18/library/modules/$.for-of", "npm:core-js@0.9.18/library/modules/$.assert", "npm:core-js@0.9.18/library/modules/$.uid", "npm:core-js@0.9.18/library/modules/$.mix", "npm:core-js@0.9.18/library/modules/$.cof", "npm:core-js@0.9.18/library/modules/$.species"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var $ = require("npm:core-js@0.9.18/library/modules/$"),
      $def = require("npm:core-js@0.9.18/library/modules/$.def"),
      $iter = require("npm:core-js@0.9.18/library/modules/$.iter"),
      BUGGY = $iter.BUGGY,
      forOf = require("npm:core-js@0.9.18/library/modules/$.for-of"),
      assertInstance = require("npm:core-js@0.9.18/library/modules/$.assert").inst,
      INTERNAL = require("npm:core-js@0.9.18/library/modules/$.uid").safe('internal');
  module.exports = function(NAME, wrapper, methods, common, IS_MAP, IS_WEAK) {
    var Base = $.g[NAME],
        C = Base,
        ADDER = IS_MAP ? 'set' : 'add',
        proto = C && C.prototype,
        O = {};
    if (!$.DESC || !$.isFunction(C) || !(IS_WEAK || !BUGGY && proto.forEach && proto.entries)) {
      C = common.getConstructor(wrapper, NAME, IS_MAP, ADDER);
      require("npm:core-js@0.9.18/library/modules/$.mix")(C.prototype, methods);
    } else {
      C = wrapper(function(target, iterable) {
        assertInstance(target, C, NAME);
        target[INTERNAL] = new Base;
        if (iterable != undefined)
          forOf(iterable, IS_MAP, target[ADDER], target);
      });
      $.each.call('add,clear,delete,forEach,get,has,set,keys,values,entries'.split(','), function(KEY) {
        var chain = KEY == 'add' || KEY == 'set';
        if (KEY in proto)
          $.hide(C.prototype, KEY, function(a, b) {
            var result = this[INTERNAL][KEY](a === 0 ? 0 : a, b);
            return chain ? this : result;
          });
      });
      if ('size' in proto)
        $.setDesc(C.prototype, 'size', {get: function() {
            return this[INTERNAL].size;
          }});
    }
    require("npm:core-js@0.9.18/library/modules/$.cof").set(C, NAME);
    O[NAME] = C;
    $def($def.G + $def.W + $def.F, O);
    require("npm:core-js@0.9.18/library/modules/$.species")(C);
    if (!IS_WEAK)
      common.setIter(C, NAME, IS_MAP);
    return C;
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.18/library/modules/es7.map.to-json", ["npm:core-js@0.9.18/library/modules/$.collection-to-json"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  require("npm:core-js@0.9.18/library/modules/$.collection-to-json")('Map');
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.18/library/modules/$.collection-weak", ["npm:core-js@0.9.18/library/modules/$", "npm:core-js@0.9.18/library/modules/$.uid", "npm:core-js@0.9.18/library/modules/$.assert", "npm:core-js@0.9.18/library/modules/$.for-of", "npm:core-js@0.9.18/library/modules/$.array-methods", "npm:core-js@0.9.18/library/modules/$.mix"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var $ = require("npm:core-js@0.9.18/library/modules/$"),
      safe = require("npm:core-js@0.9.18/library/modules/$.uid").safe,
      assert = require("npm:core-js@0.9.18/library/modules/$.assert"),
      forOf = require("npm:core-js@0.9.18/library/modules/$.for-of"),
      $has = $.has,
      isObject = $.isObject,
      hide = $.hide,
      isExtensible = Object.isExtensible || isObject,
      id = 0,
      ID = safe('id'),
      WEAK = safe('weak'),
      LEAK = safe('leak'),
      method = require("npm:core-js@0.9.18/library/modules/$.array-methods"),
      find = method(5),
      findIndex = method(6);
  function findFrozen(store, key) {
    return find(store.array, function(it) {
      return it[0] === key;
    });
  }
  function leakStore(that) {
    return that[LEAK] || hide(that, LEAK, {
      array: [],
      get: function(key) {
        var entry = findFrozen(this, key);
        if (entry)
          return entry[1];
      },
      has: function(key) {
        return !!findFrozen(this, key);
      },
      set: function(key, value) {
        var entry = findFrozen(this, key);
        if (entry)
          entry[1] = value;
        else
          this.array.push([key, value]);
      },
      'delete': function(key) {
        var index = findIndex(this.array, function(it) {
          return it[0] === key;
        });
        if (~index)
          this.array.splice(index, 1);
        return !!~index;
      }
    })[LEAK];
  }
  module.exports = {
    getConstructor: function(wrapper, NAME, IS_MAP, ADDER) {
      var C = wrapper(function(that, iterable) {
        $.set(assert.inst(that, C, NAME), ID, id++);
        if (iterable != undefined)
          forOf(iterable, IS_MAP, that[ADDER], that);
      });
      require("npm:core-js@0.9.18/library/modules/$.mix")(C.prototype, {
        'delete': function(key) {
          if (!isObject(key))
            return false;
          if (!isExtensible(key))
            return leakStore(this)['delete'](key);
          return $has(key, WEAK) && $has(key[WEAK], this[ID]) && delete key[WEAK][this[ID]];
        },
        has: function has(key) {
          if (!isObject(key))
            return false;
          if (!isExtensible(key))
            return leakStore(this).has(key);
          return $has(key, WEAK) && $has(key[WEAK], this[ID]);
        }
      });
      return C;
    },
    def: function(that, key, value) {
      if (!isExtensible(assert.obj(key))) {
        leakStore(that).set(key, value);
      } else {
        $has(key, WEAK) || hide(key, WEAK, {});
        key[WEAK][that[ID]] = value;
      }
      return that;
    },
    leakStore: leakStore,
    WEAK: WEAK,
    ID: ID
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.18/library/modules/es6.symbol", ["npm:core-js@0.9.18/library/modules/$", "npm:core-js@0.9.18/library/modules/$.cof", "npm:core-js@0.9.18/library/modules/$.uid", "npm:core-js@0.9.18/library/modules/$.shared", "npm:core-js@0.9.18/library/modules/$.def", "npm:core-js@0.9.18/library/modules/$.redef", "npm:core-js@0.9.18/library/modules/$.keyof", "npm:core-js@0.9.18/library/modules/$.enum-keys", "npm:core-js@0.9.18/library/modules/$.assert", "npm:core-js@0.9.18/library/modules/$.get-names", "npm:core-js@0.9.18/library/modules/$.wks"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var $ = require("npm:core-js@0.9.18/library/modules/$"),
      setTag = require("npm:core-js@0.9.18/library/modules/$.cof").set,
      uid = require("npm:core-js@0.9.18/library/modules/$.uid"),
      shared = require("npm:core-js@0.9.18/library/modules/$.shared"),
      $def = require("npm:core-js@0.9.18/library/modules/$.def"),
      $redef = require("npm:core-js@0.9.18/library/modules/$.redef"),
      keyOf = require("npm:core-js@0.9.18/library/modules/$.keyof"),
      enumKeys = require("npm:core-js@0.9.18/library/modules/$.enum-keys"),
      assertObject = require("npm:core-js@0.9.18/library/modules/$.assert").obj,
      ObjectProto = Object.prototype,
      DESC = $.DESC,
      has = $.has,
      $create = $.create,
      getDesc = $.getDesc,
      setDesc = $.setDesc,
      desc = $.desc,
      $names = require("npm:core-js@0.9.18/library/modules/$.get-names"),
      getNames = $names.get,
      toObject = $.toObject,
      $Symbol = $.g.Symbol,
      setter = false,
      TAG = uid('tag'),
      HIDDEN = uid('hidden'),
      _propertyIsEnumerable = {}.propertyIsEnumerable,
      SymbolRegistry = shared('symbol-registry'),
      AllSymbols = shared('symbols'),
      useNative = $.isFunction($Symbol);
  var setSymbolDesc = DESC ? function() {
    try {
      return $create(setDesc({}, HIDDEN, {get: function() {
          return setDesc(this, HIDDEN, {value: false})[HIDDEN];
        }}))[HIDDEN] || setDesc;
    } catch (e) {
      return function(it, key, D) {
        var protoDesc = getDesc(ObjectProto, key);
        if (protoDesc)
          delete ObjectProto[key];
        setDesc(it, key, D);
        if (protoDesc && it !== ObjectProto)
          setDesc(ObjectProto, key, protoDesc);
      };
    }
  }() : setDesc;
  function wrap(tag) {
    var sym = AllSymbols[tag] = $.set($create($Symbol.prototype), TAG, tag);
    DESC && setter && setSymbolDesc(ObjectProto, tag, {
      configurable: true,
      set: function(value) {
        if (has(this, HIDDEN) && has(this[HIDDEN], tag))
          this[HIDDEN][tag] = false;
        setSymbolDesc(this, tag, desc(1, value));
      }
    });
    return sym;
  }
  function defineProperty(it, key, D) {
    if (D && has(AllSymbols, key)) {
      if (!D.enumerable) {
        if (!has(it, HIDDEN))
          setDesc(it, HIDDEN, desc(1, {}));
        it[HIDDEN][key] = true;
      } else {
        if (has(it, HIDDEN) && it[HIDDEN][key])
          it[HIDDEN][key] = false;
        D = $create(D, {enumerable: desc(0, false)});
      }
      return setSymbolDesc(it, key, D);
    }
    return setDesc(it, key, D);
  }
  function defineProperties(it, P) {
    assertObject(it);
    var keys = enumKeys(P = toObject(P)),
        i = 0,
        l = keys.length,
        key;
    while (l > i)
      defineProperty(it, key = keys[i++], P[key]);
    return it;
  }
  function create(it, P) {
    return P === undefined ? $create(it) : defineProperties($create(it), P);
  }
  function propertyIsEnumerable(key) {
    var E = _propertyIsEnumerable.call(this, key);
    return E || !has(this, key) || !has(AllSymbols, key) || has(this, HIDDEN) && this[HIDDEN][key] ? E : true;
  }
  function getOwnPropertyDescriptor(it, key) {
    var D = getDesc(it = toObject(it), key);
    if (D && has(AllSymbols, key) && !(has(it, HIDDEN) && it[HIDDEN][key]))
      D.enumerable = true;
    return D;
  }
  function getOwnPropertyNames(it) {
    var names = getNames(toObject(it)),
        result = [],
        i = 0,
        key;
    while (names.length > i)
      if (!has(AllSymbols, key = names[i++]) && key != HIDDEN)
        result.push(key);
    return result;
  }
  function getOwnPropertySymbols(it) {
    var names = getNames(toObject(it)),
        result = [],
        i = 0,
        key;
    while (names.length > i)
      if (has(AllSymbols, key = names[i++]))
        result.push(AllSymbols[key]);
    return result;
  }
  if (!useNative) {
    $Symbol = function Symbol() {
      if (this instanceof $Symbol)
        throw TypeError('Symbol is not a constructor');
      return wrap(uid(arguments[0]));
    };
    $redef($Symbol.prototype, 'toString', function() {
      return this[TAG];
    });
    $.create = create;
    $.setDesc = defineProperty;
    $.getDesc = getOwnPropertyDescriptor;
    $.setDescs = defineProperties;
    $.getNames = $names.get = getOwnPropertyNames;
    $.getSymbols = getOwnPropertySymbols;
    if ($.DESC && $.FW)
      $redef(ObjectProto, 'propertyIsEnumerable', propertyIsEnumerable, true);
  }
  var symbolStatics = {
    'for': function(key) {
      return has(SymbolRegistry, key += '') ? SymbolRegistry[key] : SymbolRegistry[key] = $Symbol(key);
    },
    keyFor: function keyFor(key) {
      return keyOf(SymbolRegistry, key);
    },
    useSetter: function() {
      setter = true;
    },
    useSimple: function() {
      setter = false;
    }
  };
  $.each.call(('hasInstance,isConcatSpreadable,iterator,match,replace,search,' + 'species,split,toPrimitive,toStringTag,unscopables').split(','), function(it) {
    var sym = require("npm:core-js@0.9.18/library/modules/$.wks")(it);
    symbolStatics[it] = useNative ? sym : wrap(sym);
  });
  setter = true;
  $def($def.G + $def.W, {Symbol: $Symbol});
  $def($def.S, 'Symbol', symbolStatics);
  $def($def.S + $def.F * !useNative, 'Object', {
    create: create,
    defineProperty: defineProperty,
    defineProperties: defineProperties,
    getOwnPropertyDescriptor: getOwnPropertyDescriptor,
    getOwnPropertyNames: getOwnPropertyNames,
    getOwnPropertySymbols: getOwnPropertySymbols
  });
  setTag($Symbol, 'Symbol');
  setTag(Math, 'Math', true);
  setTag($.g.JSON, 'JSON', true);
  global.define = __define;
  return module.exports;
});

System.register("npm:babel-runtime@5.8.34/core-js/object/create", ["npm:core-js@0.9.18/library/fn/object/create"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  module.exports = {
    "default": require("npm:core-js@0.9.18/library/fn/object/create"),
    __esModule: true
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:process@0.11.2", ["npm:process@0.11.2/browser"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  module.exports = require("npm:process@0.11.2/browser");
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.18/library/fn/object/get-own-property-descriptor", ["npm:core-js@0.9.18/library/modules/$", "npm:core-js@0.9.18/library/modules/es6.object.statics-accept-primitives"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var $ = require("npm:core-js@0.9.18/library/modules/$");
  require("npm:core-js@0.9.18/library/modules/es6.object.statics-accept-primitives");
  module.exports = function getOwnPropertyDescriptor(it, key) {
    return $.getDesc(it, key);
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:babel-runtime@5.8.34/core-js/object/keys", ["npm:core-js@0.9.18/library/fn/object/keys"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  module.exports = {
    "default": require("npm:core-js@0.9.18/library/fn/object/keys"),
    __esModule: true
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.18/library/fn/get-iterator", ["npm:core-js@0.9.18/library/modules/web.dom.iterable", "npm:core-js@0.9.18/library/modules/es6.string.iterator", "npm:core-js@0.9.18/library/modules/core.iter-helpers", "npm:core-js@0.9.18/library/modules/$"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  require("npm:core-js@0.9.18/library/modules/web.dom.iterable");
  require("npm:core-js@0.9.18/library/modules/es6.string.iterator");
  require("npm:core-js@0.9.18/library/modules/core.iter-helpers");
  module.exports = require("npm:core-js@0.9.18/library/modules/$").core.getIterator;
  global.define = __define;
  return module.exports;
});

System.register("npm:js-beautify@1.5.10/js/index", ["npm:js-beautify@1.5.10/js/lib/beautify", "npm:js-beautify@1.5.10/js/lib/beautify-css", "npm:js-beautify@1.5.10/js/lib/beautify-html"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  "format cjs";
  function get_beautify(js_beautify, css_beautify, html_beautify) {
    var beautify = function(src, config) {
      return js_beautify.js_beautify(src, config);
    };
    beautify.js = js_beautify.js_beautify;
    beautify.css = css_beautify.css_beautify;
    beautify.html = html_beautify.html_beautify;
    beautify.js_beautify = js_beautify.js_beautify;
    beautify.css_beautify = css_beautify.css_beautify;
    beautify.html_beautify = html_beautify.html_beautify;
    return beautify;
  }
  if (typeof define === "function" && define.amd) {
    define(["./lib/beautify", "./lib/beautify-css", "./lib/beautify-html"], function(js_beautify, css_beautify, html_beautify) {
      return get_beautify(js_beautify, css_beautify, html_beautify);
    });
  } else {
    (function(mod) {
      var js_beautify = require("npm:js-beautify@1.5.10/js/lib/beautify");
      var css_beautify = require("npm:js-beautify@1.5.10/js/lib/beautify-css");
      var html_beautify = require("npm:js-beautify@1.5.10/js/lib/beautify-html");
      mod.exports = get_beautify(js_beautify, css_beautify, html_beautify);
    })(module);
  }
  global.define = __define;
  return module.exports;
});

System.register("npm:babel-runtime@5.8.34/core-js/object/define-properties", ["npm:core-js@0.9.18/library/fn/object/define-properties"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  module.exports = {
    "default": require("npm:core-js@0.9.18/library/fn/object/define-properties"),
    __esModule: true
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.18/library/modules/$.def", ["npm:core-js@0.9.18/library/modules/$"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var $ = require("npm:core-js@0.9.18/library/modules/$"),
      global = $.g,
      core = $.core,
      isFunction = $.isFunction;
  function ctx(fn, that) {
    return function() {
      return fn.apply(that, arguments);
    };
  }
  $def.F = 1;
  $def.G = 2;
  $def.S = 4;
  $def.P = 8;
  $def.B = 16;
  $def.W = 32;
  function $def(type, name, source) {
    var key,
        own,
        out,
        exp,
        isGlobal = type & $def.G,
        isProto = type & $def.P,
        target = isGlobal ? global : type & $def.S ? global[name] : (global[name] || {}).prototype,
        exports = isGlobal ? core : core[name] || (core[name] = {});
    if (isGlobal)
      source = name;
    for (key in source) {
      own = !(type & $def.F) && target && key in target;
      if (own && key in exports)
        continue;
      out = own ? target[key] : source[key];
      if (isGlobal && !isFunction(target[key]))
        exp = source[key];
      else if (type & $def.B && own)
        exp = ctx(out, global);
      else if (type & $def.W && target[key] == out)
        !function(C) {
          exp = function(param) {
            return this instanceof C ? new C(param) : C(param);
          };
          exp.prototype = C.prototype;
        }(out);
      else
        exp = isProto && isFunction(out) ? ctx(Function.call, out) : out;
      exports[key] = exp;
      if (isProto)
        (exports.prototype || (exports.prototype = {}))[key] = out;
    }
  }
  module.exports = $def;
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.18/library/modules/$.cof", ["npm:core-js@0.9.18/library/modules/$", "npm:core-js@0.9.18/library/modules/$.wks"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var $ = require("npm:core-js@0.9.18/library/modules/$"),
      TAG = require("npm:core-js@0.9.18/library/modules/$.wks")('toStringTag'),
      toString = {}.toString;
  function cof(it) {
    return toString.call(it).slice(8, -1);
  }
  cof.classof = function(it) {
    var O,
        T;
    return it == undefined ? it === undefined ? 'Undefined' : 'Null' : typeof(T = (O = Object(it))[TAG]) == 'string' ? T : cof(O);
  };
  cof.set = function(it, tag, stat) {
    if (it && !$.has(it = stat ? it : it.prototype, TAG))
      $.hide(it, TAG, tag);
  };
  module.exports = cof;
  global.define = __define;
  return module.exports;
});

System.register("npm:babel-runtime@5.8.34/helpers/define-property", ["npm:babel-runtime@5.8.34/core-js/object/define-property"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  "use strict";
  var _Object$defineProperty = require("npm:babel-runtime@5.8.34/core-js/object/define-property")["default"];
  exports["default"] = function(obj, key, value) {
    if (key in obj) {
      _Object$defineProperty(obj, key, {
        value: value,
        enumerable: true,
        configurable: true,
        writable: true
      });
    } else {
      obj[key] = value;
    }
    return obj;
  };
  exports.__esModule = true;
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.18/library/modules/web.dom.iterable", ["npm:core-js@0.9.18/library/modules/es6.array.iterator", "npm:core-js@0.9.18/library/modules/$", "npm:core-js@0.9.18/library/modules/$.iter", "npm:core-js@0.9.18/library/modules/$.wks"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  require("npm:core-js@0.9.18/library/modules/es6.array.iterator");
  var $ = require("npm:core-js@0.9.18/library/modules/$"),
      Iterators = require("npm:core-js@0.9.18/library/modules/$.iter").Iterators,
      ITERATOR = require("npm:core-js@0.9.18/library/modules/$.wks")('iterator'),
      ArrayValues = Iterators.Array,
      NL = $.g.NodeList,
      HTC = $.g.HTMLCollection,
      NLProto = NL && NL.prototype,
      HTCProto = HTC && HTC.prototype;
  if ($.FW) {
    if (NL && !(ITERATOR in NLProto))
      $.hide(NLProto, ITERATOR, ArrayValues);
    if (HTC && !(ITERATOR in HTCProto))
      $.hide(HTCProto, ITERATOR, ArrayValues);
  }
  Iterators.NodeList = Iterators.HTMLCollection = ArrayValues;
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.18/library/modules/es6.map", ["npm:core-js@0.9.18/library/modules/$.collection-strong", "npm:core-js@0.9.18/library/modules/$.collection"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var strong = require("npm:core-js@0.9.18/library/modules/$.collection-strong");
  require("npm:core-js@0.9.18/library/modules/$.collection")('Map', function(get) {
    return function Map() {
      return get(this, arguments[0]);
    };
  }, {
    get: function get(key) {
      var entry = strong.getEntry(this, key);
      return entry && entry.v;
    },
    set: function set(key, value) {
      return strong.def(this, key === 0 ? 0 : key, value);
    }
  }, strong, true);
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.18/library/modules/es6.weak-map", ["npm:core-js@0.9.18/library/modules/$", "npm:core-js@0.9.18/library/modules/$.collection-weak", "npm:core-js@0.9.18/library/modules/$.collection", "npm:core-js@0.9.18/library/modules/$.redef"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var $ = require("npm:core-js@0.9.18/library/modules/$"),
      weak = require("npm:core-js@0.9.18/library/modules/$.collection-weak"),
      leakStore = weak.leakStore,
      ID = weak.ID,
      WEAK = weak.WEAK,
      has = $.has,
      isObject = $.isObject,
      isExtensible = Object.isExtensible || isObject,
      tmp = {};
  var $WeakMap = require("npm:core-js@0.9.18/library/modules/$.collection")('WeakMap', function(get) {
    return function WeakMap() {
      return get(this, arguments[0]);
    };
  }, {
    get: function get(key) {
      if (isObject(key)) {
        if (!isExtensible(key))
          return leakStore(this).get(key);
        if (has(key, WEAK))
          return key[WEAK][this[ID]];
      }
    },
    set: function set(key, value) {
      return weak.def(this, key, value);
    }
  }, weak, true, true);
  if (new $WeakMap().set((Object.freeze || Object)(tmp), 7).get(tmp) != 7) {
    $.each.call(['delete', 'has', 'get', 'set'], function(key) {
      var proto = $WeakMap.prototype,
          method = proto[key];
      require("npm:core-js@0.9.18/library/modules/$.redef")(proto, key, function(a, b) {
        if (isObject(a) && !isExtensible(a)) {
          var result = leakStore(this)[key](a, b);
          return key == 'set' ? this : result;
        }
        return method.call(this, a, b);
      });
    });
  }
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.18/library/fn/symbol/index", ["npm:core-js@0.9.18/library/modules/es6.symbol", "npm:core-js@0.9.18/library/modules/$"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  require("npm:core-js@0.9.18/library/modules/es6.symbol");
  module.exports = require("npm:core-js@0.9.18/library/modules/$").core.Symbol;
  global.define = __define;
  return module.exports;
});

System.register("github:jspm/nodelibs-process@0.1.2/index", ["npm:process@0.11.2"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  module.exports = System._nodeRequire ? process : require("npm:process@0.11.2");
  global.define = __define;
  return module.exports;
});

System.register("npm:babel-runtime@5.8.34/core-js/object/get-own-property-descriptor", ["npm:core-js@0.9.18/library/fn/object/get-own-property-descriptor"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  module.exports = {
    "default": require("npm:core-js@0.9.18/library/fn/object/get-own-property-descriptor"),
    __esModule: true
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:babel-runtime@5.8.34/core-js/get-iterator", ["npm:core-js@0.9.18/library/fn/get-iterator"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  module.exports = {
    "default": require("npm:core-js@0.9.18/library/fn/get-iterator"),
    __esModule: true
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:js-beautify@1.5.10", ["npm:js-beautify@1.5.10/js/index"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  module.exports = require("npm:js-beautify@1.5.10/js/index");
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.18/library/modules/es6.object.assign", ["npm:core-js@0.9.18/library/modules/$.def", "npm:core-js@0.9.18/library/modules/$.assign"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var $def = require("npm:core-js@0.9.18/library/modules/$.def");
  $def($def.S, 'Object', {assign: require("npm:core-js@0.9.18/library/modules/$.assign")});
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.18/library/modules/$.iter", ["npm:core-js@0.9.18/library/modules/$", "npm:core-js@0.9.18/library/modules/$.cof", "npm:core-js@0.9.18/library/modules/$.assert", "npm:core-js@0.9.18/library/modules/$.wks", "npm:core-js@0.9.18/library/modules/$.shared"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var $ = require("npm:core-js@0.9.18/library/modules/$"),
      cof = require("npm:core-js@0.9.18/library/modules/$.cof"),
      classof = cof.classof,
      assert = require("npm:core-js@0.9.18/library/modules/$.assert"),
      assertObject = assert.obj,
      SYMBOL_ITERATOR = require("npm:core-js@0.9.18/library/modules/$.wks")('iterator'),
      FF_ITERATOR = '@@iterator',
      Iterators = require("npm:core-js@0.9.18/library/modules/$.shared")('iterators'),
      IteratorPrototype = {};
  setIterator(IteratorPrototype, $.that);
  function setIterator(O, value) {
    $.hide(O, SYMBOL_ITERATOR, value);
    if (FF_ITERATOR in [])
      $.hide(O, FF_ITERATOR, value);
  }
  module.exports = {
    BUGGY: 'keys' in [] && !('next' in [].keys()),
    Iterators: Iterators,
    step: function(done, value) {
      return {
        value: value,
        done: !!done
      };
    },
    is: function(it) {
      var O = Object(it),
          Symbol = $.g.Symbol;
      return (Symbol && Symbol.iterator || FF_ITERATOR) in O || SYMBOL_ITERATOR in O || $.has(Iterators, classof(O));
    },
    get: function(it) {
      var Symbol = $.g.Symbol,
          getIter;
      if (it != undefined) {
        getIter = it[Symbol && Symbol.iterator || FF_ITERATOR] || it[SYMBOL_ITERATOR] || Iterators[classof(it)];
      }
      assert($.isFunction(getIter), it, ' is not iterable!');
      return assertObject(getIter.call(it));
    },
    set: setIterator,
    create: function(Constructor, NAME, next, proto) {
      Constructor.prototype = $.create(proto || IteratorPrototype, {next: $.desc(1, next)});
      cof.set(Constructor, NAME + ' Iterator');
    }
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.18/library/fn/map", ["npm:core-js@0.9.18/library/modules/es6.object.to-string", "npm:core-js@0.9.18/library/modules/es6.string.iterator", "npm:core-js@0.9.18/library/modules/web.dom.iterable", "npm:core-js@0.9.18/library/modules/es6.map", "npm:core-js@0.9.18/library/modules/es7.map.to-json", "npm:core-js@0.9.18/library/modules/$"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  require("npm:core-js@0.9.18/library/modules/es6.object.to-string");
  require("npm:core-js@0.9.18/library/modules/es6.string.iterator");
  require("npm:core-js@0.9.18/library/modules/web.dom.iterable");
  require("npm:core-js@0.9.18/library/modules/es6.map");
  require("npm:core-js@0.9.18/library/modules/es7.map.to-json");
  module.exports = require("npm:core-js@0.9.18/library/modules/$").core.Map;
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.18/library/fn/weak-map", ["npm:core-js@0.9.18/library/modules/es6.object.to-string", "npm:core-js@0.9.18/library/modules/es6.array.iterator", "npm:core-js@0.9.18/library/modules/es6.weak-map", "npm:core-js@0.9.18/library/modules/$"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  require("npm:core-js@0.9.18/library/modules/es6.object.to-string");
  require("npm:core-js@0.9.18/library/modules/es6.array.iterator");
  require("npm:core-js@0.9.18/library/modules/es6.weak-map");
  module.exports = require("npm:core-js@0.9.18/library/modules/$").core.WeakMap;
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.18/library/fn/symbol", ["npm:core-js@0.9.18/library/fn/symbol/index"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  module.exports = require("npm:core-js@0.9.18/library/fn/symbol/index");
  global.define = __define;
  return module.exports;
});

System.register("github:jspm/nodelibs-process@0.1.2", ["github:jspm/nodelibs-process@0.1.2/index"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  module.exports = require("github:jspm/nodelibs-process@0.1.2/index");
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.18/library/fn/object/assign", ["npm:core-js@0.9.18/library/modules/es6.object.assign", "npm:core-js@0.9.18/library/modules/$"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  require("npm:core-js@0.9.18/library/modules/es6.object.assign");
  module.exports = require("npm:core-js@0.9.18/library/modules/$").core.Object.assign;
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.18/library/modules/es6.string.iterator", ["npm:core-js@0.9.18/library/modules/$", "npm:core-js@0.9.18/library/modules/$.string-at", "npm:core-js@0.9.18/library/modules/$.uid", "npm:core-js@0.9.18/library/modules/$.iter", "npm:core-js@0.9.18/library/modules/$.iter-define"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var set = require("npm:core-js@0.9.18/library/modules/$").set,
      $at = require("npm:core-js@0.9.18/library/modules/$.string-at")(true),
      ITER = require("npm:core-js@0.9.18/library/modules/$.uid").safe('iter'),
      $iter = require("npm:core-js@0.9.18/library/modules/$.iter"),
      step = $iter.step;
  require("npm:core-js@0.9.18/library/modules/$.iter-define")(String, 'String', function(iterated) {
    set(this, ITER, {
      o: String(iterated),
      i: 0
    });
  }, function() {
    var iter = this[ITER],
        O = iter.o,
        index = iter.i,
        point;
    if (index >= O.length)
      return step(1);
    point = $at(O, index);
    iter.i += point.length;
    return step(0, point);
  });
  global.define = __define;
  return module.exports;
});

System.register("npm:babel-runtime@5.8.34/core-js/map", ["npm:core-js@0.9.18/library/fn/map"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  module.exports = {
    "default": require("npm:core-js@0.9.18/library/fn/map"),
    __esModule: true
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:babel-runtime@5.8.34/core-js/weak-map", ["npm:core-js@0.9.18/library/fn/weak-map"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  module.exports = {
    "default": require("npm:core-js@0.9.18/library/fn/weak-map"),
    __esModule: true
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:babel-runtime@5.8.34/core-js/symbol", ["npm:core-js@0.9.18/library/fn/symbol"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  module.exports = {
    "default": require("npm:core-js@0.9.18/library/fn/symbol"),
    __esModule: true
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.18/library/modules/$.task", ["npm:core-js@0.9.18/library/modules/$", "npm:core-js@0.9.18/library/modules/$.ctx", "npm:core-js@0.9.18/library/modules/$.cof", "npm:core-js@0.9.18/library/modules/$.invoke", "npm:core-js@0.9.18/library/modules/$.dom-create", "github:jspm/nodelibs-process@0.1.2"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  (function(process) {
    'use strict';
    var $ = require("npm:core-js@0.9.18/library/modules/$"),
        ctx = require("npm:core-js@0.9.18/library/modules/$.ctx"),
        cof = require("npm:core-js@0.9.18/library/modules/$.cof"),
        invoke = require("npm:core-js@0.9.18/library/modules/$.invoke"),
        cel = require("npm:core-js@0.9.18/library/modules/$.dom-create"),
        global = $.g,
        isFunction = $.isFunction,
        html = $.html,
        process = global.process,
        setTask = global.setImmediate,
        clearTask = global.clearImmediate,
        MessageChannel = global.MessageChannel,
        counter = 0,
        queue = {},
        ONREADYSTATECHANGE = 'onreadystatechange',
        defer,
        channel,
        port;
    function run() {
      var id = +this;
      if ($.has(queue, id)) {
        var fn = queue[id];
        delete queue[id];
        fn();
      }
    }
    function listner(event) {
      run.call(event.data);
    }
    if (!isFunction(setTask) || !isFunction(clearTask)) {
      setTask = function(fn) {
        var args = [],
            i = 1;
        while (arguments.length > i)
          args.push(arguments[i++]);
        queue[++counter] = function() {
          invoke(isFunction(fn) ? fn : Function(fn), args);
        };
        defer(counter);
        return counter;
      };
      clearTask = function(id) {
        delete queue[id];
      };
      if (cof(process) == 'process') {
        defer = function(id) {
          process.nextTick(ctx(run, id, 1));
        };
      } else if (global.addEventListener && isFunction(global.postMessage) && !global.importScripts) {
        defer = function(id) {
          global.postMessage(id, '*');
        };
        global.addEventListener('message', listner, false);
      } else if (isFunction(MessageChannel)) {
        channel = new MessageChannel;
        port = channel.port2;
        channel.port1.onmessage = listner;
        defer = ctx(port.postMessage, port, 1);
      } else if (ONREADYSTATECHANGE in cel('script')) {
        defer = function(id) {
          html.appendChild(cel('script'))[ONREADYSTATECHANGE] = function() {
            html.removeChild(this);
            run.call(id);
          };
        };
      } else {
        defer = function(id) {
          setTimeout(ctx(run, id, 1), 0);
        };
      }
    }
    module.exports = {
      set: setTask,
      clear: clearTask
    };
  })(require("github:jspm/nodelibs-process@0.1.2"));
  global.define = __define;
  return module.exports;
});

System.register("npm:babel-runtime@5.8.34/core-js/object/assign", ["npm:core-js@0.9.18/library/fn/object/assign"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  module.exports = {
    "default": require("npm:core-js@0.9.18/library/fn/object/assign"),
    __esModule: true
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.18/library/fn/array/from", ["npm:core-js@0.9.18/library/modules/es6.string.iterator", "npm:core-js@0.9.18/library/modules/es6.array.from", "npm:core-js@0.9.18/library/modules/$"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  require("npm:core-js@0.9.18/library/modules/es6.string.iterator");
  require("npm:core-js@0.9.18/library/modules/es6.array.from");
  module.exports = require("npm:core-js@0.9.18/library/modules/$").core.Array.from;
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.18/library/modules/es6.promise", ["npm:core-js@0.9.18/library/modules/$", "npm:core-js@0.9.18/library/modules/$.ctx", "npm:core-js@0.9.18/library/modules/$.cof", "npm:core-js@0.9.18/library/modules/$.def", "npm:core-js@0.9.18/library/modules/$.assert", "npm:core-js@0.9.18/library/modules/$.for-of", "npm:core-js@0.9.18/library/modules/$.set-proto", "npm:core-js@0.9.18/library/modules/$.same", "npm:core-js@0.9.18/library/modules/$.species", "npm:core-js@0.9.18/library/modules/$.wks", "npm:core-js@0.9.18/library/modules/$.uid", "npm:core-js@0.9.18/library/modules/$.task", "npm:core-js@0.9.18/library/modules/$.mix", "npm:core-js@0.9.18/library/modules/$.iter-detect", "github:jspm/nodelibs-process@0.1.2"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  (function(process) {
    'use strict';
    var $ = require("npm:core-js@0.9.18/library/modules/$"),
        ctx = require("npm:core-js@0.9.18/library/modules/$.ctx"),
        cof = require("npm:core-js@0.9.18/library/modules/$.cof"),
        $def = require("npm:core-js@0.9.18/library/modules/$.def"),
        assert = require("npm:core-js@0.9.18/library/modules/$.assert"),
        forOf = require("npm:core-js@0.9.18/library/modules/$.for-of"),
        setProto = require("npm:core-js@0.9.18/library/modules/$.set-proto").set,
        same = require("npm:core-js@0.9.18/library/modules/$.same"),
        species = require("npm:core-js@0.9.18/library/modules/$.species"),
        SPECIES = require("npm:core-js@0.9.18/library/modules/$.wks")('species'),
        RECORD = require("npm:core-js@0.9.18/library/modules/$.uid").safe('record'),
        PROMISE = 'Promise',
        global = $.g,
        process = global.process,
        isNode = cof(process) == 'process',
        asap = process && process.nextTick || require("npm:core-js@0.9.18/library/modules/$.task").set,
        P = global[PROMISE],
        isFunction = $.isFunction,
        isObject = $.isObject,
        assertFunction = assert.fn,
        assertObject = assert.obj,
        Wrapper;
    function testResolve(sub) {
      var test = new P(function() {});
      if (sub)
        test.constructor = Object;
      return P.resolve(test) === test;
    }
    var useNative = function() {
      var works = false;
      function P2(x) {
        var self = new P(x);
        setProto(self, P2.prototype);
        return self;
      }
      try {
        works = isFunction(P) && isFunction(P.resolve) && testResolve();
        setProto(P2, P);
        P2.prototype = $.create(P.prototype, {constructor: {value: P2}});
        if (!(P2.resolve(5).then(function() {}) instanceof P2)) {
          works = false;
        }
        if (works && $.DESC) {
          var thenableThenGotten = false;
          P.resolve($.setDesc({}, 'then', {get: function() {
              thenableThenGotten = true;
            }}));
          works = thenableThenGotten;
        }
      } catch (e) {
        works = false;
      }
      return works;
    }();
    function isPromise(it) {
      return isObject(it) && (useNative ? cof.classof(it) == 'Promise' : RECORD in it);
    }
    function sameConstructor(a, b) {
      if (!$.FW && a === P && b === Wrapper)
        return true;
      return same(a, b);
    }
    function getConstructor(C) {
      var S = assertObject(C)[SPECIES];
      return S != undefined ? S : C;
    }
    function isThenable(it) {
      var then;
      if (isObject(it))
        then = it.then;
      return isFunction(then) ? then : false;
    }
    function notify(record) {
      var chain = record.c;
      if (chain.length)
        asap.call(global, function() {
          var value = record.v,
              ok = record.s == 1,
              i = 0;
          function run(react) {
            var cb = ok ? react.ok : react.fail,
                ret,
                then;
            try {
              if (cb) {
                if (!ok)
                  record.h = true;
                ret = cb === true ? value : cb(value);
                if (ret === react.P) {
                  react.rej(TypeError('Promise-chain cycle'));
                } else if (then = isThenable(ret)) {
                  then.call(ret, react.res, react.rej);
                } else
                  react.res(ret);
              } else
                react.rej(value);
            } catch (err) {
              react.rej(err);
            }
          }
          while (chain.length > i)
            run(chain[i++]);
          chain.length = 0;
        });
    }
    function isUnhandled(promise) {
      var record = promise[RECORD],
          chain = record.a || record.c,
          i = 0,
          react;
      if (record.h)
        return false;
      while (chain.length > i) {
        react = chain[i++];
        if (react.fail || !isUnhandled(react.P))
          return false;
      }
      return true;
    }
    function $reject(value) {
      var record = this,
          promise;
      if (record.d)
        return ;
      record.d = true;
      record = record.r || record;
      record.v = value;
      record.s = 2;
      record.a = record.c.slice();
      setTimeout(function() {
        asap.call(global, function() {
          if (isUnhandled(promise = record.p)) {
            if (isNode) {
              process.emit('unhandledRejection', value, promise);
            } else if (global.console && console.error) {
              console.error('Unhandled promise rejection', value);
            }
          }
          record.a = undefined;
        });
      }, 1);
      notify(record);
    }
    function $resolve(value) {
      var record = this,
          then;
      if (record.d)
        return ;
      record.d = true;
      record = record.r || record;
      try {
        if (then = isThenable(value)) {
          asap.call(global, function() {
            var wrapper = {
              r: record,
              d: false
            };
            try {
              then.call(value, ctx($resolve, wrapper, 1), ctx($reject, wrapper, 1));
            } catch (e) {
              $reject.call(wrapper, e);
            }
          });
        } else {
          record.v = value;
          record.s = 1;
          notify(record);
        }
      } catch (e) {
        $reject.call({
          r: record,
          d: false
        }, e);
      }
    }
    if (!useNative) {
      P = function Promise(executor) {
        assertFunction(executor);
        var record = {
          p: assert.inst(this, P, PROMISE),
          c: [],
          a: undefined,
          s: 0,
          d: false,
          v: undefined,
          h: false
        };
        $.hide(this, RECORD, record);
        try {
          executor(ctx($resolve, record, 1), ctx($reject, record, 1));
        } catch (err) {
          $reject.call(record, err);
        }
      };
      require("npm:core-js@0.9.18/library/modules/$.mix")(P.prototype, {
        then: function then(onFulfilled, onRejected) {
          var S = assertObject(assertObject(this).constructor)[SPECIES];
          var react = {
            ok: isFunction(onFulfilled) ? onFulfilled : true,
            fail: isFunction(onRejected) ? onRejected : false
          };
          var promise = react.P = new (S != undefined ? S : P)(function(res, rej) {
            react.res = assertFunction(res);
            react.rej = assertFunction(rej);
          });
          var record = this[RECORD];
          record.c.push(react);
          if (record.a)
            record.a.push(react);
          if (record.s)
            notify(record);
          return promise;
        },
        'catch': function(onRejected) {
          return this.then(undefined, onRejected);
        }
      });
    }
    $def($def.G + $def.W + $def.F * !useNative, {Promise: P});
    cof.set(P, PROMISE);
    species(P);
    species(Wrapper = $.core[PROMISE]);
    $def($def.S + $def.F * !useNative, PROMISE, {reject: function reject(r) {
        return new (getConstructor(this))(function(res, rej) {
          rej(r);
        });
      }});
    $def($def.S + $def.F * (!useNative || testResolve(true)), PROMISE, {resolve: function resolve(x) {
        return isPromise(x) && sameConstructor(x.constructor, this) ? x : new this(function(res) {
          res(x);
        });
      }});
    $def($def.S + $def.F * !(useNative && require("npm:core-js@0.9.18/library/modules/$.iter-detect")(function(iter) {
      P.all(iter)['catch'](function() {});
    })), PROMISE, {
      all: function all(iterable) {
        var C = getConstructor(this),
            values = [];
        return new C(function(res, rej) {
          forOf(iterable, false, values.push, values);
          var remaining = values.length,
              results = Array(remaining);
          if (remaining)
            $.each.call(values, function(promise, index) {
              C.resolve(promise).then(function(value) {
                results[index] = value;
                --remaining || res(results);
              }, rej);
            });
          else
            res(results);
        });
      },
      race: function race(iterable) {
        var C = getConstructor(this);
        return new C(function(res, rej) {
          forOf(iterable, false, function(promise) {
            C.resolve(promise).then(res, rej);
          });
        });
      }
    });
  })(require("github:jspm/nodelibs-process@0.1.2"));
  global.define = __define;
  return module.exports;
});

System.register("npm:babel-runtime@5.8.34/helpers/extends", ["npm:babel-runtime@5.8.34/core-js/object/assign"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  "use strict";
  var _Object$assign = require("npm:babel-runtime@5.8.34/core-js/object/assign")["default"];
  exports["default"] = _Object$assign || function(target) {
    for (var i = 1; i < arguments.length; i++) {
      var source = arguments[i];
      for (var key in source) {
        if (Object.prototype.hasOwnProperty.call(source, key)) {
          target[key] = source[key];
        }
      }
    }
    return target;
  };
  exports.__esModule = true;
  global.define = __define;
  return module.exports;
});

System.register("npm:babel-runtime@5.8.34/core-js/array/from", ["npm:core-js@0.9.18/library/fn/array/from"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  module.exports = {
    "default": require("npm:core-js@0.9.18/library/fn/array/from"),
    __esModule: true
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.18/library/fn/promise", ["npm:core-js@0.9.18/library/modules/es6.object.to-string", "npm:core-js@0.9.18/library/modules/es6.string.iterator", "npm:core-js@0.9.18/library/modules/web.dom.iterable", "npm:core-js@0.9.18/library/modules/es6.promise", "npm:core-js@0.9.18/library/modules/$"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  require("npm:core-js@0.9.18/library/modules/es6.object.to-string");
  require("npm:core-js@0.9.18/library/modules/es6.string.iterator");
  require("npm:core-js@0.9.18/library/modules/web.dom.iterable");
  require("npm:core-js@0.9.18/library/modules/es6.promise");
  module.exports = require("npm:core-js@0.9.18/library/modules/$").core.Promise;
  global.define = __define;
  return module.exports;
});

System.register("npm:babel-runtime@5.8.34/helpers/to-consumable-array", ["npm:babel-runtime@5.8.34/core-js/array/from"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  "use strict";
  var _Array$from = require("npm:babel-runtime@5.8.34/core-js/array/from")["default"];
  exports["default"] = function(arr) {
    if (Array.isArray(arr)) {
      for (var i = 0,
          arr2 = Array(arr.length); i < arr.length; i++)
        arr2[i] = arr[i];
      return arr2;
    } else {
      return _Array$from(arr);
    }
  };
  exports.__esModule = true;
  global.define = __define;
  return module.exports;
});

System.register("npm:babel-runtime@5.8.34/core-js/promise", ["npm:core-js@0.9.18/library/fn/promise"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  module.exports = {
    "default": require("npm:core-js@0.9.18/library/fn/promise"),
    __esModule: true
  };
  global.define = __define;
  return module.exports;
});

System.register('src/bit/is', ['src/index'], function (_export) {
	'use strict';

	var _bit;

	return {
		setters: [function (_srcIndex) {
			_bit = _srcIndex.bit;
		}],
		execute: function () {
			_export('default', {
				bit: function bit(x) {
					return x instanceof _bit;
				},
				object: function object(x) {
					return x !== null && typeof x === 'object';
					// || typeof x == 'function'
				},
				array: function array(x) {
					return Array.isArray(x);
				},
				fn: function fn(x) {
					return typeof x === 'function';
				},
				primitive: function primitive(x) {
					return typeof x === 'string' || typeof x === 'number';
				}
			});
		}
	};
});
System.register('src/box/parser/event', ['npm:babel-runtime@5.8.34/core-js/object/keys'], function (_export) {
	var _Object$keys;

	function isFunction(v) {
		return typeof v === 'function' || false;
	}

	function event(el) {

		el = el || {};

		var callbacks = {},
		    _id = 0;

		el.events = {};
		el.getEvents = function () {
			return _Object$keys(callbacks);
		};

		el.update = function (payload, value) {
			var diff = {};
			if (value && typeof payload === 'string') {
				var key = payload;
				payload = {};
				payload[key] = value;
			}
			if (payload && typeof payload === 'object') {
				_Object$keys(payload).map(function (k) {
					if (el[k] !== payload[k]) {
						diff[k] = {
							old: el[k],
							'new': payload[k]
						};
						el[k] = payload[k];
					}
				});
			}
			el.emit('update', payload, diff);
		};

		el.sub = function (events, fn) {
			if (isFunction(fn)) {
				fn._id = typeof fn._id == 'undefined' ? _id++ : fn._id;
				events.replace(/\S+/g, function (name, pos) {
					(callbacks[name] = callbacks[name] || []).push(fn);
					fn.typed = pos > 0;
				});
			}
			return el;
		};

		el.on = function (events, fn) {
			if (events === undefined) events = [];

			if (isFunction(fn)) {
				fn._id = typeof fn._id == 'undefined' ? _id++ : fn._id;

				if (!Array.isArray(events)) events = [events];
				events.map(function (name) {

					if (name !== 'listener' && name !== 'update') {
						el.events[name] = true;
						el.emit('listener', name);
					}

					(callbacks[name] = callbacks[name] || []).push(fn);
					//fn.typed = pos > 0
				});
			}
			return el;
		};

		el.off = function (events, fn) {
			if (events == '*') {
				callbacks = {};
			} else {
				if (!Array.isArray(events)) events = [events];
				events.map(function (name) {
					if (fn) {
						var arr = callbacks[name];
						for (var i = 0, cb; cb = arr && arr[i]; ++i) {
							if (cb._id == fn._id) {
								arr.splice(i, 1);
								i--;
							}
						}
					} else {
						callbacks[name] = [];
					}
				});
			}
			return el;
		};

		el.one = function (name, fn) {
			function on() {
				el.off(name, on);
				fn.apply(el, arguments);
			}
			return el.on(name, on);
		};

		el.pub = function (name) {

			var args = [].slice.call(arguments, 1),
			    fns = callbacks[name] || [];

			for (var i = 0, fn; fn = fns[i]; ++i) {
				if (!fn.busy) {
					fn.busy = 1;
					fn.apply(el, fn.typed ? [name].concat(args) : args);
					if (fns[i] !== fn) {
						i--;
					}
					fn.busy = 0;
				}
			}

			if (callbacks.all && name != '*') {
				el.trigger.apply(el, ['*', name].concat(args));
			}

			return el;
		};

		el.emit = function (name) {
			var args = [].slice.call(arguments, 1),
			    fns = callbacks[name] || [];

			for (var i = 0, fn; fn = fns[i]; ++i) {
				if (!fn.busy) {
					fn.busy = 1;
					fn.apply(el, fn.typed ? [name].concat(args) : args);
					if (fns[i] !== fn) {
						i--;
					}
					fn.busy = 0;
				}
			}

			if (callbacks.all && name != '*') {
				el.trigger.apply(el, ['*', name].concat(args));
			}

			return el;
		};

		el.trigger = function (name) {
			var args = [].slice.call(arguments, 1),
			    fns = callbacks[name] || [];

			for (var i = 0, fn; fn = fns[i]; ++i) {
				if (!fn.busy) {
					fn.busy = 1;
					fn.apply(el, fn.typed ? [name].concat(args) : args);
					if (fns[i] !== fn) {
						i--;
					}
					fn.busy = 0;
				}
			}

			if (callbacks.all && name != '*') {
				el.trigger.apply(el, ['*', name].concat(args));
			}

			return el;
		};

		return el;
	}

	return {
		setters: [function (_npmBabelRuntime5834CoreJsObjectKeys) {
			_Object$keys = _npmBabelRuntime5834CoreJsObjectKeys['default'];
		}],
		execute: function () {
			'use strict';

			_export('default', event);
		}
	};
});
System.register('src/box/parser/dom', [], function (_export) {
	'use strict';

	return {
		setters: [],
		execute: function () {
			_export('default', {

				content: 'content',

				a: 'a',
				abbr: 'abbr',
				address: 'address',
				area: 'area',
				article: 'article',
				aside: 'aside',
				audio: 'audio',
				b: 'b',
				base: 'base',
				bdi: 'bdi',
				bdo: 'bdo',
				big: 'big',
				blockquote: 'blockquote',
				body: 'body',
				br: 'br',
				button: 'button',
				canvas: 'canvas',
				caption: 'caption',
				cite: 'cite',
				code: 'code',
				col: 'col',
				colgroup: 'colgroup',
				data: 'data',
				datalist: 'datalist',
				dd: 'dd',
				del: 'del',
				details: 'details',
				dfn: 'dfn',
				dialog: 'dialog',
				div: 'div',
				dl: 'dl',
				dt: 'dt',
				em: 'em',
				embed: 'embed',
				fieldset: 'fieldset',
				figcaption: 'figcaption',
				figure: 'figure',
				footer: 'footer',
				form: 'form',
				h1: 'h1',
				h2: 'h2',
				h3: 'h3',
				h4: 'h4',
				h5: 'h5',
				h6: 'h6',
				head: 'head',
				header: 'header',
				hr: 'hr',
				html: 'html',
				i: 'i',
				iframe: 'iframe',
				img: 'img',
				input: 'input',
				ins: 'ins',
				kbd: 'kbd',
				keygen: 'keygen',
				label: 'label',
				legend: 'legend',
				li: 'li',
				link: 'link',
				main: 'main',
				map: 'map',
				mark: 'mark',
				menu: 'menu',
				menuitem: 'menuitem',
				meta: 'meta',
				meter: 'meter',
				nav: 'nav',
				noscript: 'noscript',
				object: 'object',
				ol: 'ol',
				optgroup: 'optgroup',
				option: 'option',
				output: 'output',
				p: 'p',
				param: 'param',
				picture: 'picture',
				pre: 'pre',
				progress: 'progress',
				q: 'q',
				rp: 'rp',
				rt: 'rt',
				ruby: 'ruby',
				s: 's',
				samp: 'samp',
				script: 'script',
				section: 'section',
				select: 'select',
				small: 'small',
				source: 'source',
				span: 'span',
				strong: 'strong',
				style: 'style',
				sub: 'sub',
				summary: 'summary',
				sup: 'sup',
				table: 'table',
				tbody: 'tbody',
				td: 'td',
				textarea: 'textarea',
				tfoot: 'tfoot',
				th: 'th',
				thead: 'thead',
				time: 'time',
				title: 'title',
				tr: 'tr',
				track: 'track',
				u: 'u',
				ul: 'ul',
				'var': 'var',
				video: 'video',
				wbr: 'wbr',

				// SVG
				circle: 'circle',
				clipPath: 'clipPath',
				defs: 'defs',
				ellipse: 'ellipse',
				g: 'g',
				line: 'line',
				linearGradient: 'linearGradient',
				mask: 'mask',
				path: 'path',
				pattern: 'pattern',
				polygon: 'polygon',
				polyline: 'polyline',
				radialGradient: 'radialGradient',
				rect: 'rect',
				stop: 'stop',
				svg: 'svg',
				text: 'text',
				tspan: 'tspan'

			});

			//
		}
	};
});
System.register('src/box/parser/helpers', [], function (_export) {
	'use strict';

	_export('camelCase', camelCase);

	function camelCase(subj, all) {
		if (subj.indexOf('-') > -1) {
			var parts = subj.split('-');
			subj = parts.map(function (p, i) {
				return !all && i === 0 ? p : p.substr(0, 1).toUpperCase() + p.substr(1);
			}).join('');
		}
		return !all ? subj : subj.substr(0, 1).toUpperCase() + subj.substr(1);
	}

	return {
		setters: [],
		execute: function () {}
	};
});
System.register('src/box/parser/nodes/export', ['src/box/parser/helpers'], function (_export) {
	'use strict';

	var camelCase;
	return {
		setters: [function (_srcBoxParserHelpers) {
			camelCase = _srcBoxParserHelpers.camelCase;
		}],
		execute: function () {
			_export('default', function (node) {

				console.log('node:export', node);

				var exp = node.attrs.map(function (prop) {
					if (prop.type === 'value') return '{ ' + prop.value + ' as ' + camelCase(prop.key) + ' }';else return '' + camelCase(prop.key);
				});

				return 'export ' + exp.join(' ') + ';\n';
			});
		}
	};
});
System.register("src/box/parser/nodes/script", [], function (_export) {
	"use strict";

	return {
		setters: [],
		execute: function () {
			_export("default", function (node) {
				return "" + node.body;
			});
		}
	};
});
System.register('src/box/parser/nodes/style', [], function (_export) {
	// export function parse(tag, style, type) {
	// 	return style.replace(/:box/g, tag)
	// }
	// //'${ node.parent.name }',
	// export default function(node) {
	// 	node.body = parse(node.parent.name, node.body)
	// 	node.body = node.body.replace(/\s+/g, ' ').replace(/\\/g, '\\\\').replace(/'/g, "\\'").trim()
	// 	return `$bb.style('${ node.body }')`
	//
	// }
	'use strict';

	var __boxvar__, CSS_SELECTOR, CSS_COMMENT;

	_export('parse', parse);

	function parse(tag, style, type) {

		return style.replace(CSS_COMMENT, '').replace(CSS_SELECTOR, function (m, p1, p2) {

			return p1 + ' ' + p2.split(/\s*,\s*/g).map(function (sel) {

				var s = sel.trim().replace(/:box\s*/, '').trim();
				return '' + tag + (s && s.indexOf(':') !== 0 && s.indexOf('.') !== 0 && s.indexOf('#') !== 0 ? ' > ' : '') + s + ' ';
			}).join(',');
		}).trim();
	}

	return {
		setters: [],
		execute: function () {
			__boxvar__ = 'this$box';
			CSS_SELECTOR = /(^|\}|\{)\s*([^\{\}]+)\s*[^\$](?=\{)/g;
			CSS_COMMENT = /\/\*[^\x00]*?\*\//gm;

			_export('default', function (node) {

				node.body = node.body.replace(/\s+/g, ' ').replace(/\\/g, '\\\\').trim();
				return __boxvar__ + '.style(`' + parse(node.parent.name, node.body) + '`)';
			});
		}
	};
});
System.register("src/box/parser/nodes/mod", [], function (_export) {
	"use strict";

	return {
		setters: [],
		execute: function () {
			_export("default", function (node) {
				return "" + node.body;
			});
		}
	};
});
System.register('src/box/node', ['npm:babel-runtime@5.8.34/helpers/slice', 'npm:babel-runtime@5.8.34/core-js/symbol'], function (_export) {
	var _slice, _Symbol;

	function node() {
		var _arguments = _slice.call(arguments);

		var name = _arguments[0];
		var meta = _arguments[1];
		var children = _arguments[2];
		var text = _arguments[3];
		var element = _arguments[4];

		var key = meta && meta.key ? meta.key : undefined;

		return {
			key: key, name: name, meta: meta, children: children, text: text, element: element,
			___: 0,
			sel: name,
			data: meta,
			elm: element
		};
	}

	return {
		setters: [function (_npmBabelRuntime5834HelpersSlice) {
			_slice = _npmBabelRuntime5834HelpersSlice['default'];
		}, function (_npmBabelRuntime5834CoreJsSymbol) {
			_Symbol = _npmBabelRuntime5834CoreJsSymbol['default'];
		}],
		execute: function () {
			/** [box] node
   	tree node object model
   	*/

			'use strict';

			_export('default', node);

			node.type = _Symbol('box.node');
			node.version = 0.1;
		}
	};
});
System.register('src/box/patch/class', [], function (_export) {
    'use strict';

    function updateClass(oldVnode, vnode) {

        if (!vnode.data) return;

        var cur,
            name,
            elm = vnode.elm,
            oldClass = oldVnode.data['class'] || {},
            klass = vnode.data['class'] || {};
        for (name in klass) {
            cur = klass[name];
            if (cur !== oldClass[name]) {
                elm.classList[cur ? 'add' : 'remove'](name);
            }
        }
    }

    return {
        setters: [],
        execute: function () {
            _export('default', {
                create: updateClass,
                update: updateClass
            });
        }
    };
});
System.register('src/box/patch/props', [], function (_export) {
  'use strict';

  function updateProps(oldVnode, vnode) {
    var key,
        cur,
        old,
        elm = vnode.elm,
        oldProps = oldVnode.data || {},
        props = vnode.data || {};

    for (key in props) {

      if (key === 'class' || key === 'on' || key === 'style') continue;

      cur = props[key];
      old = oldProps[key];
      if (old !== cur) {
        elm[key] = cur;
      }
    }
  }

  return {
    setters: [],
    execute: function () {
      _export('default', {
        create: updateProps,
        update: updateProps
      });
    }
  };
});
System.register('src/box/patch/style', [], function (_export) {
  'use strict';

  var raf, nextFrame;

  function setNextFrame(obj, prop, val) {
    nextFrame(function () {
      obj[prop] = val;
    });
  }
  function format(s, v) {
    var px = ['padding', 'margin', 'top', 'left', 'right', 'bottom', 'fontSize', 'height', 'width', 'minHeight', 'minWidth', 'maxHeight', 'maxWidth'];
    if (typeof v === 'number' && px.indexOf(s) > -1) return v + 'px';
    return v;
  }
  function updateStyle(oldVnode, vnode) {
    var cur,
        name,
        elm = vnode.elm,
        oldStyle = oldVnode.data.style || {},
        style = vnode.data.style || {},
        oldHasDel = ('delayed' in oldStyle);
    for (name in style) {
      cur = style[name];
      if (name === 'delayed') {
        for (name in style.delayed) {
          cur = style.delayed[name];
          if (!oldHasDel || cur !== oldStyle.delayed[name]) {
            setNextFrame(elm.style, name, format(name, cur));
          }
        }
      } else if (name !== 'remove' && cur !== oldStyle[name]) {
        elm.style[name] = format(name, cur);
      }
    }
  }

  function applyDestroyStyle(vnode) {
    var style,
        name,
        elm = vnode.elm,
        s = vnode.data.style;
    if (!s || !(style = s.destroy)) return;
    for (name in style) {
      elm.style[name] = format(name, style[name]);
    }
  }

  function applyRemoveStyle(vnode, rm) {
    var s = vnode.data.style;
    if (!s || !s.remove) {
      rm();
      return;
    }
    var name,
        elm = vnode.elm,
        idx,
        i = 0,
        maxDur = 0,
        compStyle,
        style = s.remove,
        amount = 0,
        applied = [];
    for (name in style) {
      applied.push(name);
      elm.style[name] = format(name, style[name]);
    }
    compStyle = getComputedStyle(elm);
    var props = compStyle['transition-property'].split(', ');
    for (; i < props.length; ++i) {
      if (applied.indexOf(props[i]) !== -1) amount++;
    }
    elm.addEventListener('transitionend', function (ev) {
      if (ev.target === elm) --amount;
      if (amount === 0) rm();
    });
  }

  return {
    setters: [],
    execute: function () {
      raf = requestAnimationFrame || setTimeout;

      nextFrame = function nextFrame(fn) {
        raf(function () {
          raf(fn);
        });
      };

      _export('default', {
        create: updateStyle,
        update: updateStyle,
        destroy: applyDestroyStyle,
        remove: applyRemoveStyle
      });
    }
  };
});
System.register("src/box/patch/events", ["npm:babel-runtime@5.8.34/helpers/to-consumable-array", "src/bit/is"], function (_export) {
	var _toConsumableArray, is;

	function arrInvoker(arr) {
		return function (ev) {
			ev.preventDefault();
			if (is.bit(arr[0])) {
				var _arr$0;

				(_arr$0 = arr[0]).pub.apply(_arr$0, _toConsumableArray(arr.slice(1)));
			} else {
				if (arr.length === 2) arr[0](arr[1], ev);else arr[0].apply(arr, _toConsumableArray(arr.slice(1)).concat([ev]));
			}
		};
	}

	function fnInvoker(o) {
		return function (ev) {
			ev.preventDefault();
			o.fn(ev);
		};
	}

	function updateEventListeners(oldVnode, vnode) {
		var name,
		    cur,
		    old,
		    elm = vnode.elm,
		    oldOn = oldVnode.data.on || {},
		    on = vnode.data.on;
		if (!on) return;
		for (name in on) {
			cur = on[name];
			old = oldOn[name];
			if (old === undefined) {
				if (is.array(cur)) {
					elm.addEventListener(name, arrInvoker(cur));
				} else {
					cur = {
						fn: cur
					};
					on[name] = cur;
					elm.addEventListener(name, fnInvoker(cur));
				}
			} else if (is.array(old)) {
				old.length = cur.length;
				for (var i = 0; i < old.length; ++i) old[i] = cur[i];
				on[name] = old;
			} else {
				old.fn = cur;
				on[name] = old;
			}
		}
	}
	return {
		setters: [function (_npmBabelRuntime5834HelpersToConsumableArray) {
			_toConsumableArray = _npmBabelRuntime5834HelpersToConsumableArray["default"];
		}, function (_srcBitIs) {
			is = _srcBitIs["default"];
		}],
		execute: function () {
			"use strict";

			_export("default", {
				create: updateEventListeners,
				update: updateEventListeners
			});
		}
	};
});
System.register('src/box/color', ['npm:babel-runtime@5.8.34/core-js/object/keys'], function (_export) {
	var _Object$keys, colors;

	function hexToRGBA(color) {
		var alpha = arguments.length <= 1 || arguments[1] === undefined ? 1 : arguments[1];

		if (color.length === 4) {
			var extendedColor = '#';
			for (var i = 1; i < color.length; i++) {
				extendedColor += color.charAt(i) + color.charAt(i);
			}
			color = extendedColor;
		}

		var values = {
			r: parseInt(color.substr(1, 2), 16),
			g: parseInt(color.substr(3, 2), 16),
			b: parseInt(color.substr(5, 2), 16)
		};

		return 'rgba(' + values.r + ',' + values.g + ',' + values.b + ',' + alpha + ')';
	}

	function color(name) {
		var index = arguments.length <= 1 || arguments[1] === undefined ? 500 : arguments[1];
		var alpha = arguments.length <= 2 || arguments[2] === undefined ? 1 : arguments[2];

		if (index <= 1) {
			alpha = index;
			index = 500;
		}
		return name ? getColor(name, index, alpha) : getRandomColor(index, alpha);
	}

	function getColor(name, index, alpha) {
		if (index === undefined) index = 500;

		if (name === 'black' || name === 'white') index = '';
		return colors[name + index] ? hexToRGBA(colors[name + index], alpha) : 'inherit';
	}

	function getRandomColor(index, alpha) {
		if (index === undefined) index = 500;

		var item = colors.index[Math.floor(Math.random() * colors.index.length)];
		return getColor(item, index, alpha);
	}
	return {
		setters: [function (_npmBabelRuntime5834CoreJsObjectKeys) {
			_Object$keys = _npmBabelRuntime5834CoreJsObjectKeys['default'];
		}],
		execute: function () {
			'use strict';

			_export('default', color);

			colors = {

				random: function random() {
					var hex = arguments.length <= 0 || arguments[0] === undefined ? false : arguments[0];
					var i = arguments.length <= 1 || arguments[1] === undefined ? 0 : arguments[1];

					var keys = _Object$keys(colors);
					var item = colors.index[Math.floor(Math.random() * colors.index.length)];
					return hex ? colors[item + i] : i ? item + String(i) : item;
				},

				index: ['red', 'pink', 'purple', 'deepPurple', 'indigo', 'blue', 'lightBlue', 'cyan', 'teal', 'green', 'lightGreen', 'lime', 'yellow', 'amber', 'orange', 'deepOrange', 'brown', 'blueGrey', 'grey', 'black', 'slate'
				//'white'
				],

				slate900: '#181a1f',
				slate800: '#21252b',
				slate500: '#282c34',
				slate50: '#abb2bf',

				red50: '#ffebee',
				red100: '#ffcdd2',
				red200: '#ef9a9a',
				red300: '#e57373',
				red400: '#ef5350',
				red500: '#f44336',
				red600: '#e53935',
				red700: '#d32f2f',
				red800: '#c62828',
				red900: '#b71c1c',
				redA100: '#ff8a80',
				redA200: '#ff5252',
				redA400: '#ff1744',
				redA700: '#d50000',

				pink50: '#fce4ec',
				pink100: '#f8bbd0',
				pink200: '#f48fb1',
				pink300: '#f06292',
				pink400: '#ec407a',
				pink500: '#e91e63',
				pink600: '#d81b60',
				pink700: '#c2185b',
				pink800: '#ad1457',
				pink900: '#880e4f',
				pinkA100: '#ff80ab',
				pinkA200: '#ff4081',
				pinkA400: '#f50057',
				pinkA700: '#c51162',

				purple50: '#f3e5f5',
				purple100: '#e1bee7',
				purple200: '#ce93d8',
				purple300: '#ba68c8',
				purple400: '#ab47bc',
				purple500: '#9c27b0',
				purple600: '#8e24aa',
				purple700: '#7b1fa2',
				purple800: '#6a1b9a',
				purple900: '#4a148c',
				purpleA100: '#ea80fc',
				purpleA200: '#e040fb',
				purpleA400: '#d500f9',
				purpleA700: '#aa00ff',

				deepPurple50: '#ede7f6',
				deepPurple100: '#d1c4e9',
				deepPurple200: '#b39ddb',
				deepPurple300: '#9575cd',
				deepPurple400: '#7e57c2',
				deepPurple500: '#673ab7',
				deepPurple600: '#5e35b1',
				deepPurple700: '#512da8',
				deepPurple800: '#4527a0',
				deepPurple900: '#311b92',
				deepPurpleA100: '#b388ff',
				deepPurpleA200: '#7c4dff',
				deepPurpleA400: '#651fff',
				deepPurpleA700: '#6200ea',

				indigo50: '#e8eaf6',
				indigo100: '#c5cae9',
				indigo200: '#9fa8da',
				indigo300: '#7986cb',
				indigo400: '#5c6bc0',
				indigo500: '#3f51b5',
				indigo600: '#3949ab',
				indigo700: '#303f9f',
				indigo800: '#283593',
				indigo900: '#1a237e',
				indigoA100: '#8c9eff',
				indigoA200: '#536dfe',
				indigoA400: '#3d5afe',
				indigoA700: '#304ffe',

				blue50: '#e3f2fd',
				blue100: '#bbdefb',
				blue200: '#90caf9',
				blue300: '#64b5f6',
				blue400: '#42a5f5',
				blue500: '#2196f3',
				blue600: '#1e88e5',
				blue700: '#1976d2',
				blue800: '#1565c0',
				blue900: '#0d47a1',
				blueA100: '#82b1ff',
				blueA200: '#448aff',
				blueA400: '#2979ff',
				blueA700: '#2962ff',

				lightBlue50: '#e1f5fe',
				lightBlue100: '#b3e5fc',
				lightBlue200: '#81d4fa',
				lightBlue300: '#4fc3f7',
				lightBlue400: '#29b6f6',
				lightBlue500: '#03a9f4',
				lightBlue600: '#039be5',
				lightBlue700: '#0288d1',
				lightBlue800: '#0277bd',
				lightBlue900: '#01579b',
				lightBlueA100: '#80d8ff',
				lightBlueA200: '#40c4ff',
				lightBlueA400: '#00b0ff',
				lightBlueA700: '#0091ea',

				cyan50: '#e0f7fa',
				cyan100: '#b2ebf2',
				cyan200: '#80deea',
				cyan300: '#4dd0e1',
				cyan400: '#26c6da',
				cyan500: '#00bcd4',
				cyan600: '#00acc1',
				cyan700: '#0097a7',
				cyan800: '#00838f',
				cyan900: '#006064',
				cyanA100: '#84ffff',
				cyanA200: '#18ffff',
				cyanA400: '#00e5ff',
				cyanA700: '#00b8d4',

				teal50: '#e0f2f1',
				teal100: '#b2dfdb',
				teal200: '#80cbc4',
				teal300: '#4db6ac',
				teal400: '#26a69a',
				teal500: '#009688',
				teal600: '#00897b',
				teal700: '#00796b',
				teal800: '#00695c',
				teal900: '#004d40',
				tealA100: '#a7ffeb',
				tealA200: '#64ffda',
				tealA400: '#1de9b6',
				tealA700: '#00bfa5',

				green50: '#e8f5e9',
				green100: '#c8e6c9',
				green200: '#a5d6a7',
				green300: '#81c784',
				green400: '#66bb6a',
				green500: '#4caf50',
				green600: '#43a047',
				green700: '#388e3c',
				green800: '#2e7d32',
				green900: '#1b5e20',
				greenA100: '#b9f6ca',
				greenA200: '#69f0ae',
				greenA400: '#00e676',
				greenA700: '#00c853',

				lightGreen50: '#f1f8e9',
				lightGreen100: '#dcedc8',
				lightGreen200: '#c5e1a5',
				lightGreen300: '#aed581',
				lightGreen400: '#9ccc65',
				lightGreen500: '#8bc34a',
				lightGreen600: '#7cb342',
				lightGreen700: '#689f38',
				lightGreen800: '#558b2f',
				lightGreen900: '#33691e',
				lightGreenA100: '#ccff90',
				lightGreenA200: '#b2ff59',
				lightGreenA400: '#76ff03',
				lightGreenA700: '#64dd17',

				lime50: '#f9fbe7',
				lime100: '#f0f4c3',
				lime200: '#e6ee9c',
				lime300: '#dce775',
				lime400: '#d4e157',
				lime500: '#cddc39',
				lime600: '#c0ca33',
				lime700: '#afb42b',
				lime800: '#9e9d24',
				lime900: '#827717',
				limeA100: '#f4ff81',
				limeA200: '#eeff41',
				limeA400: '#c6ff00',
				limeA700: '#aeea00',

				yellow50: '#fffde7',
				yellow100: '#fff9c4',
				yellow200: '#fff59d',
				yellow300: '#fff176',
				yellow400: '#ffee58',
				yellow500: '#ffeb3b',
				yellow600: '#fdd835',
				yellow700: '#fbc02d',
				yellow800: '#f9a825',
				yellow900: '#f57f17',
				yellowA100: '#ffff8d',
				yellowA200: '#ffff00',
				yellowA400: '#ffea00',
				yellowA700: '#ffd600',

				amber50: '#fff8e1',
				amber100: '#ffecb3',
				amber200: '#ffe082',
				amber300: '#ffd54f',
				amber400: '#ffca28',
				amber500: '#ffc107',
				amber600: '#ffb300',
				amber700: '#ffa000',
				amber800: '#ff8f00',
				amber900: '#ff6f00',
				amberA100: '#ffe57f',
				amberA200: '#ffd740',
				amberA400: '#ffc400',
				amberA700: '#ffab00',

				orange50: '#fff3e0',
				orange100: '#ffe0b2',
				orange200: '#ffcc80',
				orange300: '#ffb74d',
				orange400: '#ffa726',
				orange500: '#ff9800',
				orange600: '#fb8c00',
				orange700: '#f57c00',
				orange800: '#ef6c00',
				orange900: '#e65100',
				orangeA100: '#ffd180',
				orangeA200: '#ffab40',
				orangeA400: '#ff9100',
				orangeA700: '#ff6d00',

				deepOrange50: '#fbe9e7',
				deepOrange100: '#ffccbc',
				deepOrange200: '#ffab91',
				deepOrange300: '#ff8a65',
				deepOrange400: '#ff7043',
				deepOrange500: '#ff5722',
				deepOrange600: '#f4511e',
				deepOrange700: '#e64a19',
				deepOrange800: '#d84315',
				deepOrange900: '#bf360c',
				deepOrangeA100: '#ff9e80',
				deepOrangeA200: '#ff6e40',
				deepOrangeA400: '#ff3d00',
				deepOrangeA700: '#dd2c00',

				brown50: '#efebe9',
				brown100: '#d7ccc8',
				brown200: '#bcaaa4',
				brown300: '#a1887f',
				brown400: '#8d6e63',
				brown500: '#795548',
				brown600: '#6d4c41',
				brown700: '#5d4037',
				brown800: '#4e342e',
				brown900: '#3e2723',

				blueGrey50: '#eceff1',
				blueGrey100: '#cfd8dc',
				blueGrey200: '#b0bec5',
				blueGrey300: '#90a4ae',
				blueGrey400: '#78909c',
				blueGrey500: '#607d8b',
				blueGrey600: '#546e7a',
				blueGrey700: '#455a64',
				blueGrey800: '#37474f',
				blueGrey900: '#263238',

				grey50: '#fafafa',
				grey100: '#f5f5f5',
				grey200: '#eeeeee',
				grey300: '#e0e0e0',
				grey400: '#bdbdbd',
				grey500: '#9e9e9e',
				grey600: '#757575',
				grey700: '#616161',
				grey800: '#424242',
				grey900: '#212121',

				black: '#000000',
				white: '#ffffff',

				transparent: 'rgba(0, 0, 0, 0)',
				fullBlack: 'rgba(0, 0, 0, 1)',
				darkBlack: 'rgba(0, 0, 0, 0.87)',
				lightBlack: 'rgba(0, 0, 0, 0.54)',
				minBlack: 'rgba(0, 0, 0, 0.26)',
				faintBlack: 'rgba(0, 0, 0, 0.12)',
				fullWhite: 'rgba(255, 255, 255, 1)',
				darkWhite: 'rgba(255, 255, 255, 0.87)',
				lightWhite: 'rgba(255, 255, 255, 0.54)'

			};
		}
	};
});
System.register('repo/input!box', ['npm:babel-runtime@5.8.34/helpers/extends', 'src/index'], function (_export) {
	var _extends, bitbox, bit, box;

	function input() {
		var _this = this;

		var props = arguments.length <= 0 || arguments[0] === undefined ? {} : arguments[0];

		return new box('input', _extends({
			key: 'input-box'
		}, props, {
			value: props.value || this[props.name || 'value'],
			style: _extends({
				background: box.color('black', 0.1),
				color: box.color('slate', 50, 0.8),
				fontSize: '14px',
				boxShadow: 'none',
				outline: 'none',
				padding: 8 + "px",
				margin: 8 + "px",
				border: '0'
			}, props.style),
			on: {
				input: props.on && props.on.input || function (e) {
					return _this.pub && _this.pub(props.name || 'value', e.target.value);
				}
			}
		}), (function ($tree) {
			return $tree;
		})([]));
	}

	return {
		setters: [function (_npmBabelRuntime5834HelpersExtends) {
			_extends = _npmBabelRuntime5834HelpersExtends['default'];
		}, function (_srcIndex) {
			bitbox = _srcIndex['default'];
			bit = _srcIndex.bit;
			box = _srcIndex.box;
		}],
		execute: function () {
			'use strict';

			_export('input', input);

			box(input);
		}
	};
});
System.register('chat/message!box', ['src/index'], function (_export) {
	'use strict';

	var bitbox, bit, box;

	_export('message', message);

	function message(props) {
		var _this = this;

		return new box('message', {
			key: 'message-box',
			style: {
				display: 'block',
				borderBottom: '1px solid ' + box.color('blue'),
				padding: 8 + "px"
			}
		}, (function ($tree) {
			$tree.push(box.call(_this, 'b', {}, (function ($tree) {
				$tree.push(_this.id, ' ');
				return $tree;
			})([])));
			$tree.push(box.call(_this, 'i', {}, (function ($tree) {
				$tree.push(_this.value);
				return $tree;
			})([])));
			return $tree;
		})([]));
	}

	return {
		setters: [function (_srcIndex) {
			bitbox = _srcIndex['default'];
			bit = _srcIndex.bit;
			box = _srcIndex.box;
		}],
		execute: function () {
			box(message);
		}
	};
});
System.register('chat/send!box', ['src/index'], function (_export) {
	'use strict';

	var bitbox, bit, box, style;

	_export('send', send);

	function send() {
		var _this = this;

		return new box('send', {
			key: 'send-box',
			style: style
		}, (function ($tree) {
			$tree.push(box.call(_this, 'form', {
				on: {
					submit: onSubmit.bind(_this)
				}
			}, (function ($tree) {
				$tree.push(box.call(_this, 'div', {
					style: {
						margin: 8 + "px"
					}
				}, (function ($tree) {
					$tree.push('> ', _this['in'].value || '...');
					return $tree;
				})([])));
				$tree.push(box.call(_this.out, 'input', {
					bit: _this.out,
					autofocus: 1
				}));
				return $tree;
			})([])));
			return $tree;
		})([]));
	}

	function onSubmit(e) {
		this.send.pub(e.target[0].value);
		e.target[0].value = '';
	}
	return {
		setters: [function (_srcIndex) {
			bitbox = _srcIndex['default'];
			bit = _srcIndex.bit;
			box = _srcIndex.box;
		}],
		execute: function () {
			box(send);
			style = {
				display: 'block',
				position: 'fixed',
				bottom: 0,
				left: 0,
				width: window.innerWidth,
				background: box.color('slate', 50, 0.5),
				zIndex: 10
			};
		}
	};
});
System.register('src/box/parser/nodes/import', ['npm:babel-runtime@5.8.34/core-js/object/keys', 'src/box/parser/helpers'], function (_export) {
	var _Object$keys, camelCase;

	return {
		setters: [function (_npmBabelRuntime5834CoreJsObjectKeys) {
			_Object$keys = _npmBabelRuntime5834CoreJsObjectKeys['default'];
		}, function (_srcBoxParserHelpers) {
			camelCase = _srcBoxParserHelpers.camelCase;
		}],
		execute: function () {
			'use strict';

			_export('default', function (node, meta) {

				if (node.attrs.length === 1 && node.attrs[0].key === 'import' && node.attrs[0].type === 'static') {
					return 'import \'' + node.attrs[0].value + '\';\n';
				}

				var keys = _Object$keys(node.props);

				//if (keys[0].indexOf('-') > -1) keys[0] = `{ ${ camelCase(keys[0]) } }`

				var name = camelCase(keys[0]);

				var exp = node.attrs.map(function (prop) {
					if (prop.type === 'value') return '{ ' + prop.value + ' as ' + camelCase(prop.key) + ' }';else return '' + camelCase(prop.key);
				});
				var src = node.props.from ? node.props.from : exp[0];
				meta[name] = src; //.replace(/['"`]/g, '')
				if (src.indexOf('!box') > -1)
					//	return `` // `// import ${ name } | $.import('${ name }')\n`
					return 'import { ' + name + ' } from ' + (node.props.from ? src : 'from \'' + src + '\'') + ';\n';else return 'import ' + exp.join(' ') + ' ' + (node.props.from ? src : 'from \'' + src + '\'') + ';\n';
				//return `import ${ exp.join(` `) } ${ node.props.from ? src : `from '${ src }'` };\n`
			});
		}
	};
});
System.register('src/box/patch/snabbdom', ['src/box/node', 'src/bit/is'], function (_export) {
	'use strict';

	var VNode, is, emptyNode, insertedVnodeQueue, hooks;

	_export('default', init);

	function isUndef(s) {
		return s === undefined;
	}
	function isDef(s) {
		return s !== undefined;
	}
	function emptyNodeAt(elm) {
		return VNode(elm.tagName, {}, [], undefined, elm);
	}

	function sameVnode(vnode1, vnode2) {
		return vnode1.key === vnode2.key && vnode1.sel === vnode2.sel;
	}
	function createKeyToOldIdx(children, beginIdx, endIdx) {
		var i,
		    map = {},
		    key;
		for (i = beginIdx; i <= endIdx; ++i) {
			key = children[i].key;
			if (isDef(key)) map[key] = i;
		}
		return map;
	}
	function createRmCb(childElm, listeners) {
		return function () {
			if (--listeners === 0) childElm.parentElement.removeChild(childElm);
		};
	}

	function init(modules) {

		var i,
		    j,
		    cbs = {};
		for (i = 0; i < hooks.length; ++i) {
			cbs[hooks[i]] = [];
			for (j = 0; j < modules.length; ++j) {
				if (modules[j][hooks[i]] !== undefined) cbs[hooks[i]].push(modules[j][hooks[i]]);
			}
		}

		function createElm(vnode) {
			var i,
			    data = vnode.data;
			if (isDef(data)) {
				if (isDef(i = data.hook) && isDef(i = i.init)) i(vnode);
				if (isDef(i = data.vnode)) vnode = i;
			}
			var elm,
			    children = vnode.children,
			    sel = vnode.sel;
			if (isDef(sel)) {
				var hashIdx = sel.indexOf('#');
				var dotIdx = sel.indexOf('.', hashIdx);
				var hash = hashIdx > 0 ? hashIdx : sel.length;
				var dot = dotIdx > 0 ? dotIdx : sel.length;
				var tag = hashIdx !== -1 || dotIdx !== -1 ? sel.slice(0, Math.min(hash, dot)) : sel;
				elm = vnode.elm = isDef(data) && isDef(i = data.ns) ? document.createElementNS(i, tag) : document.createElement(tag);
				if (hash < dot) elm.id = sel.slice(hash + 1, dot);
				if (dotIdx > 0) elm.className = sel.slice(dot + 1).replace(/\./g, ' ');
				if (is.array(children)) {
					for (i = 0; i < children.length; ++i) {
						elm.appendChild(createElm(children[i]));
					}
				} else if (is.primitive(vnode.text)) {
					elm.appendChild(document.createTextNode(vnode.text));
				}
				for (i = 0; i < cbs.create.length; ++i) cbs.create[i](emptyNode, vnode);
				i = vnode.data.hook;
				if (isDef(i)) {
					if (i.create) i.create(emptyNode, vnode);
					if (i.insert) insertedVnodeQueue.push(vnode);
				}
			} else {
				elm = vnode.elm = document.createTextNode(vnode.text);
			}
			return vnode.elm;
		}

		function addVnodes(parentElm, before, vnodes, startIdx, endIdx) {
			for (; startIdx <= endIdx; ++startIdx) {
				parentElm.insertBefore(createElm(vnodes[startIdx]), before);
			}
		}

		function invokeDestroyHook(vnode) {
			var i = vnode.data,
			    j;
			if (isDef(i)) {
				if (isDef(i = i.hook) && isDef(i = i.destroy)) i(vnode);
				for (i = 0; i < cbs.destroy.length; ++i) cbs.destroy[i](vnode);
				if (isDef(i = vnode.children)) {
					for (j = 0; j < vnode.children.length; ++j) {
						invokeDestroyHook(vnode.children[j]);
					}
				}
			}
		}

		function removeVnodes(parentElm, vnodes, startIdx, endIdx) {
			for (; startIdx <= endIdx; ++startIdx) {
				var i,
				    listeners,
				    rm,
				    ch = vnodes[startIdx];
				if (isDef(ch)) {
					if (isDef(ch.sel)) {
						invokeDestroyHook(ch);
						listeners = cbs.remove.length + 1;
						rm = createRmCb(ch.elm, listeners);
						for (i = 0; i < cbs.remove.length; ++i) cbs.remove[i](ch, rm);
						if (isDef(i = ch.data) && isDef(i = i.hook) && isDef(i = i.remove)) {
							i(ch, rm);
						} else {
							rm();
						}
					} else {
						parentElm.removeChild(ch.elm);
					}
				}
			}
		}

		function updateChildren(parentElm, oldCh, newCh) {
			var oldStartIdx = 0,
			    newStartIdx = 0;
			var oldEndIdx = oldCh.length - 1;
			var oldStartVnode = oldCh[0];
			var oldEndVnode = oldCh[oldEndIdx];
			var newEndIdx = newCh.length - 1;
			var newStartVnode = newCh[0];
			var newEndVnode = newCh[newEndIdx];
			var oldKeyToIdx, idxInOld, elmToMove, before;
			while (oldStartIdx <= oldEndIdx && newStartIdx <= newEndIdx) {
				if (isUndef(oldStartVnode)) {
					oldStartVnode = oldCh[++oldStartIdx];
				} else if (isUndef(oldEndVnode)) {
					oldEndVnode = oldCh[--oldEndIdx];
				} else if (sameVnode(oldStartVnode, newStartVnode)) {
					patchVnode(oldStartVnode, newStartVnode);
					oldStartVnode = oldCh[++oldStartIdx];
					newStartVnode = newCh[++newStartIdx];
				} else if (sameVnode(oldEndVnode, newEndVnode)) {
					patchVnode(oldEndVnode, newEndVnode);
					oldEndVnode = oldCh[--oldEndIdx];
					newEndVnode = newCh[--newEndIdx];
				} else if (sameVnode(oldStartVnode, newEndVnode)) {
					patchVnode(oldStartVnode, newEndVnode);
					parentElm.insertBefore(oldStartVnode.elm, oldEndVnode.elm.nextSibling);
					oldStartVnode = oldCh[++oldStartIdx];
					newEndVnode = newCh[--newEndIdx];
				} else if (sameVnode(oldEndVnode, newStartVnode)) {
					patchVnode(oldEndVnode, newStartVnode);
					parentElm.insertBefore(oldEndVnode.elm, oldStartVnode.elm);
					oldEndVnode = oldCh[--oldEndIdx];
					newStartVnode = newCh[++newStartIdx];
				} else {
					if (isUndef(oldKeyToIdx)) oldKeyToIdx = createKeyToOldIdx(oldCh, oldStartIdx, oldEndIdx);
					idxInOld = oldKeyToIdx[newStartVnode.key];
					if (isUndef(idxInOld)) {
						parentElm.insertBefore(createElm(newStartVnode), oldStartVnode.elm);
						newStartVnode = newCh[++newStartIdx];
					} else {
						elmToMove = oldCh[idxInOld];
						patchVnode(elmToMove, newStartVnode);
						oldCh[idxInOld] = undefined;
						parentElm.insertBefore(elmToMove.elm, oldStartVnode.elm);
						newStartVnode = newCh[++newStartIdx];
					}
				}
			}
			if (oldStartIdx > oldEndIdx) {
				before = isUndef(newCh[newEndIdx + 1]) ? null : newCh[newEndIdx + 1].elm;
				addVnodes(parentElm, before, newCh, newStartIdx, newEndIdx);
			} else if (newStartIdx > newEndIdx) {
				removeVnodes(parentElm, oldCh, oldStartIdx, oldEndIdx);
			}
		}

		function patchVnode(oldVnode, vnode) {
			var i, hook;
			if (isDef(i = vnode.data) && isDef(hook = i.hook) && isDef(i = hook.prepatch)) {
				i(oldVnode, vnode);
			}
			if (isDef(i = oldVnode.data) && isDef(i = i.vnode)) oldVnode = i;
			if (isDef(i = vnode.data) && isDef(i = i.vnode)) vnode = i;
			var elm = vnode.elm = oldVnode.elm,
			    oldCh = oldVnode.children,
			    ch = vnode.children;
			if (oldVnode === vnode) return;
			if (isDef(vnode.data)) {
				for (i = 0; i < cbs.update.length; ++i) cbs.update[i](oldVnode, vnode);
				i = vnode.data.hook;
				if (isDef(i) && isDef(i = i.update)) i(oldVnode, vnode);
			}
			if (isUndef(vnode.text)) {
				if (isDef(oldCh) && isDef(ch)) {
					if (oldCh !== ch) updateChildren(elm, oldCh, ch);
				} else if (isDef(ch)) {
					addVnodes(elm, null, ch, 0, ch.length - 1);
				} else if (isDef(oldCh)) {
					removeVnodes(elm, oldCh, 0, oldCh.length - 1);
				}
			} else if (oldVnode.text !== vnode.text) {
				elm.textContent = vnode.text;
			}
			if (isDef(hook) && isDef(i = hook.postpatch)) {
				i(oldVnode, vnode);
			}
			return vnode;
		}
		return function (oldVnode, vnode) {
			var i;
			insertedVnodeQueue = [];
			for (i = 0; i < cbs.pre.length; ++i) cbs.pre[i]();
			if (oldVnode instanceof Element) {
				if (oldVnode.parentElement !== null) {
					createElm(vnode);
					oldVnode.parentElement.replaceChild(vnode.elm, oldVnode);
				} else {
					oldVnode = emptyNodeAt(oldVnode);
					patchVnode(oldVnode, vnode);
				}
			} else {
				patchVnode(oldVnode, vnode);
			}
			for (i = 0; i < insertedVnodeQueue.length; ++i) {
				insertedVnodeQueue[i].data.hook.insert(insertedVnodeQueue[i]);
			}
			insertedVnodeQueue = undefined;
			for (i = 0; i < cbs.post.length; ++i) cbs.post[i]();
			return vnode;
		};
	}

	return {
		setters: [function (_srcBoxNode) {
			VNode = _srcBoxNode['default'];
		}, function (_srcBitIs) {
			is = _srcBitIs['default'];
		}],
		execute: function () {
			emptyNode = VNode('', {}, [], undefined, undefined);
			hooks = ['create', 'update', 'remove', 'destroy', 'pre', 'post'];
		}
	};
});
System.register('src/box/patch', ['src/box/patch/snabbdom', 'src/box/patch/class', 'src/box/patch/props', 'src/box/patch/style', 'src/box/patch/events'], function (_export) {
  'use strict';

  var snabbdom, _class, _props, _style, _event;

  return {
    setters: [function (_srcBoxPatchSnabbdom) {
      snabbdom = _srcBoxPatchSnabbdom['default'];
    }, function (_srcBoxPatchClass) {
      _class = _srcBoxPatchClass['default'];
    }, function (_srcBoxPatchProps) {
      _props = _srcBoxPatchProps['default'];
    }, function (_srcBoxPatchStyle) {
      _style = _srcBoxPatchStyle['default'];
    }, function (_srcBoxPatchEvents) {
      _event = _srcBoxPatchEvents['default'];
    }],
    execute: function () {
      _export('default', snabbdom([_class, _props, _style, _event]));
    }
  };
});
System.register('src/store', ['npm:babel-runtime@5.8.34/core-js/object/create', 'npm:babel-runtime@5.8.34/core-js/promise', 'npm:babel-runtime@5.8.34/core-js/object/define-properties', 'npm:babel-runtime@5.8.34/core-js/object/get-own-property-descriptor', 'npm:babel-runtime@5.8.34/core-js/object/define-property'], function (_export) {
    var _Object$create, _Promise, _Object$defineProperties, _Object$getOwnPropertyDescriptor, _Object$defineProperty, headEl, ie, seen, internalRegistry, externalRegistry, anonymousEntry, store;

    /*
      normalizeName() is inspired by Ember's loader:
      https://github.com/emberjs/ember.js/blob/0591740685ee2c444f2cfdbcebad0bebd89d1303/packages/loader/lib/main.js#L39-L53
     */
    function normalizeName(child, parentBase) {
        if (child.charAt(0) === '/') {
            child = child.slice(1);
        }
        if (child.charAt(0) !== '.') {
            return child;
        }
        var parts = child.split('/');
        while (parts[0] === '.' || parts[0] === '..') {
            if (parts.shift() === '..') {
                parentBase.pop();
            }
        }
        return parentBase.concat(parts).join('/');
    }

    function ensuredExecute(name) {
        var mod = internalRegistry[name];
        if (mod && !seen[name]) {
            seen[name] = true;
            // one time operation to execute the module body
            mod.execute();
        }
        return mod && mod.proxy;
    }

    function set(name, values) {
        externalRegistry[name] = values;
    }

    function get(name) {
        return externalRegistry[name] || ensuredExecute(name);
    }

    function has(name) {
        return !!externalRegistry[name] || !!internalRegistry[name];
    }

    function createScriptNode(src, callback) {
        var node = document.createElement('script');
        // use async=false for ordered async?
        // parallel-load-serial-execute http://wiki.whatwg.org/wiki/Dynamic_Script_Execution_Order
        if (node.async) {
            node.async = false;
        }
        if (ie) {
            node.onreadystatechange = function () {
                if (/loaded|complete/.test(this.readyState)) {
                    this.onreadystatechange = null;
                    callback();
                }
            };
        } else {
            node.onload = node.onerror = callback;
        }
        node.setAttribute('src', src);
        headEl.appendChild(node);
    }

    function load(name) {
        return new _Promise(function (resolve, reject) {
            createScriptNode((store.baseURL || '') + name + '.box', function (err) {
                if (anonymousEntry) {
                    store.register(name, anonymousEntry[0], anonymousEntry[1]);
                    anonymousEntry = undefined;
                }
                var mod = internalRegistry[name];
                if (!mod) {
                    reject(new Error('Error loading module ' + name));
                    return;
                }
                _Promise.all(mod.deps.map(function (dep) {
                    if (externalRegistry[dep] || internalRegistry[dep]) {
                        return _Promise.resolve();
                    }
                    return load(dep);
                })).then(resolve, reject);
            });
        });
    }

    return {
        setters: [function (_npmBabelRuntime5834CoreJsObjectCreate) {
            _Object$create = _npmBabelRuntime5834CoreJsObjectCreate['default'];
        }, function (_npmBabelRuntime5834CoreJsPromise) {
            _Promise = _npmBabelRuntime5834CoreJsPromise['default'];
        }, function (_npmBabelRuntime5834CoreJsObjectDefineProperties) {
            _Object$defineProperties = _npmBabelRuntime5834CoreJsObjectDefineProperties['default'];
        }, function (_npmBabelRuntime5834CoreJsObjectGetOwnPropertyDescriptor) {
            _Object$getOwnPropertyDescriptor = _npmBabelRuntime5834CoreJsObjectGetOwnPropertyDescriptor['default'];
        }, function (_npmBabelRuntime5834CoreJsObjectDefineProperty) {
            _Object$defineProperty = _npmBabelRuntime5834CoreJsObjectDefineProperty['default'];
        }],
        execute: function () {
            'use strict';

            headEl = document.getElementsByTagName('head')[0];
            ie = /MSIE/.test(navigator.userAgent);
            seen = _Object$create(null);
            internalRegistry = _Object$create(null);
            externalRegistry = _Object$create(null);
            store = _Object$defineProperties({
                set: set,
                get: get,
                has: has,

                'import': function _import(name) {
                    return new _Promise(function (resolve, reject) {
                        var normalizedName = normalizeName(name, []);
                        var mod = get(normalizedName);
                        return mod ? resolve(mod) : load(name).then(function () {
                            return get(normalizedName);
                        });
                    });
                },
                register: function register(name, deps, wrapper) {
                    if (Array.isArray(name)) {
                        // anounymous module
                        anonymousEntry = [];
                        anonymousEntry.push.apply(anonymousEntry, arguments);
                        return; // breaking to let the script tag to name it.
                    }
                    var proxy = _Object$create(null),
                        values = _Object$create(null),
                        mod,
                        meta;
                    // creating a new entry in the internal registry
                    internalRegistry[name] = mod = {
                        // live bindings
                        proxy: proxy,
                        // exported values
                        values: values,
                        // normalized deps
                        deps: deps.map(function (dep) {
                            return normalizeName(dep, name.split('/').slice(0, -1));
                        }),
                        // other modules that depends on this so we can push updates into those modules
                        dependants: [],
                        // method used to push updates of deps into the module body
                        update: function update(moduleName, moduleObj) {
                            meta.setters[mod.deps.indexOf(moduleName)](moduleObj);
                        },
                        execute: function execute() {
                            mod.deps.map(function (dep) {
                                var imports = externalRegistry[dep];
                                if (imports) {
                                    mod.update(dep, imports);
                                } else {
                                    imports = get(dep) && internalRegistry[dep].values; // optimization to pass plain values instead of bindings
                                    if (imports) {
                                        internalRegistry[dep].dependants.push(name);
                                        mod.update(dep, imports);
                                    }
                                }
                            });
                            meta.execute();
                        }
                    };
                    // collecting execute() and setters[]
                    meta = wrapper(function (identifier, value) {
                        values[identifier] = value;
                        mod.lock = true; // locking down the updates on the module to avoid infinite loop
                        mod.dependants.forEach(function (moduleName) {
                            if (internalRegistry[moduleName] && !internalRegistry[moduleName].lock) {
                                internalRegistry[moduleName].update(name, values);
                            }
                        });
                        mod.lock = false;
                        if (!_Object$getOwnPropertyDescriptor(proxy, identifier)) {
                            _Object$defineProperty(proxy, identifier, {
                                enumerable: true,
                                get: function get() {
                                    return values[identifier];
                                }
                            });
                        }
                        return value;
                    });
                }
            }, {
                loads: {
                    get: function get() {
                        return {
                            externalRegistry: externalRegistry,
                            internalRegistry: internalRegistry,
                            seen: seen,
                            anonymousEntry: anonymousEntry
                        };
                    },
                    configurable: true,
                    enumerable: true
                }
            });

            _export('default', store);
        }
    };
});
System.register('src/source', ['npm:js-beautify@1.5.10'], function (_export) {
	'use strict';

	var beautify, __source;

	_export('get', get);

	function get(name) {
		return __source[name];
	}

	return {
		setters: [function (_npmJsBeautify1510) {
			beautify = _npmJsBeautify1510['default'];
		}],
		execute: function () {
			__source = {};

			_export('default', function (n) {
				n.js = beautify(n.js, {
					indent_with_tabs: true,
					indent_size: 4
				});
				//n.source = n.source.replace(/\=\>/g, ' =>')
				n.source = n.source.replace(/<([a-z0-9-]+)(.*)=>(.*)<\/([a-z0-9-]+)>$/gm, "<$1$2=>$3");
				__source[n.name] = n;
				console.info('source:', n.name);
			});
		}
	};
});
System.register('src/box/parser/node', ['npm:babel-runtime@5.8.34/helpers/extends', 'npm:babel-runtime@5.8.34/helpers/to-consumable-array', 'npm:babel-runtime@5.8.34/core-js/object/keys', 'src/box/parser/dom', 'src/source', 'src/box/parser/nodes/import', 'src/box/parser/nodes/export', 'src/box/parser/nodes/script', 'src/box/parser/nodes/style', 'src/box/parser/nodes/mod'], function (_export2) {
	var _extends, _toConsumableArray, _Object$keys, dom, __source__, importNode, exportNode, scriptNode, styleNode, modNode, scope, index, boxname, LINE_COMMENT, JS_COMMENT, meta, __boxvar__, nodes;

	function normalizeStyle(subject) {

		var pxkeys = ['width', 'height', 'left', 'top', 'right', 'bottom', 'padding-', 'margin-', 'font-size', 'border-radius'];

		var result = subject.replace(/(\w+[-]?\w+)\s?[:]\s?([^,\[\{\}]+)?(\[([^\]]+)\])?/g, function (_, key, value, __) {
			if (value === undefined) value = "";
			var pos = arguments.length <= 4 || arguments[4] === undefined ? "" : arguments[4];

			key = key.trim();
			if (value) value = value.trim();

			var sub = key.split('-')[0] + '-';
			var ispx = pxkeys.indexOf(sub);
			if (ispx < 0) ispx = pxkeys.indexOf(key);

			if (ispx > -1 && value[0] !== '"' && value[0] !== '\'') if (!value.length && pos.length) {
				value = pos.trim();
				value = value.split(',');
				value = value.map(function (x) {
					x = x.trim();
					if (x.endsWith('%')) return '(' + x.substr(0, x.length - 1) + ') + "% "';else return parseInt(x) >= 0 ? '(' + x + ') + "px "' : '' + x;
				}).join(' + ');
			} else if (value.endsWith('%')) {
				value = '(' + value.substr(0, value.length - 1) + ') + "%"';
			} else {
				value = parseInt(value) >= 0 ? '(' + value + ') + "px"' : '' + value;
			} else if (value.length && pos.length) value = value + __;
			key = toCamel(key);
			if (parseInt(value) >= 0) value = '\'' + value + '\'';
			//console.log('res > ', { key, value }, parseInt(value))
			return key + ': ' + value;
		});
		//console.log('normalizeStyle >> result', result, '\n\n')
		return result;
	}

	function getProps(props) {
		var e = arguments.length <= 1 || arguments[1] === undefined ? 'key' : arguments[1];

		var x = _Object$keys(props).map(function (key) {
			if (key.indexOf('-') > -1) {
				var nk = toCamel(key);
				if (key.indexOf('on-') === 0) key = key.replace('on-', 'ev-');
				return nk + ' = props["' + key + '"]';
			}
			return toCamel(key) + ' = ' + props[key];
		});
		return x;
	}

	function convertprops(p) {
		var a = arguments.length <= 1 || arguments[1] === undefined ? ': ' : arguments[1];
		var b = arguments.length <= 2 || arguments[2] === undefined ? ', ' : arguments[2];

		var props = _extends({}, p);
		var keys = _Object$keys(props);
		var result = [];
		var events = [];

		var rest = [];

		keys.forEach(function (key) {

			var value = props[key];

			if (key.indexOf('on-') === 0) {
				events.push('' + key.replace('on-', '') + a + value);
				delete props[key];
			} else if (key === 'on') {
				var v = value.substr(1, value.length - 2);
				if (v) {
					events.push('' + v);
					delete props[key];
				} else {
					result.push('on');
				}
			} else if (key === 'class') {
				if (value.indexOf('[') === 0) {
					var parts = value.substr(1, value.length - 2).split(',');
					value = '{ ' + parts.map(function (p) {
						return p + ': true';
					}).join(', ') + ' }';
				}

				result.push('' + key + a + value);
			} else if (key === 'style') {
				result.push('' + key + a + value);
			} else if (key.indexOf('...') === 0) {
				result.push('' + toCamel(key));
			} else {
				result.push('' + toCamel(key) + a + value);
			}
		});

		if (events.length) result.push('on' + a + ' { ' + events.join(b) + ' }');

		return result.join(b);
	}

	function toCamel(subj, all) {
		if (subj.indexOf('-') > -1) {
			var parts = subj.split('-');
			subj = parts.map(function (p, i) {
				return !all && i === 0 ? p : p.substr(0, 1).toUpperCase() + p.substr(1);
			}).join('');
		}
		return !all ? subj : subj.substr(0, 1).toUpperCase() + subj.substr(1);
	}
	return {
		setters: [function (_npmBabelRuntime5834HelpersExtends) {
			_extends = _npmBabelRuntime5834HelpersExtends['default'];
		}, function (_npmBabelRuntime5834HelpersToConsumableArray) {
			_toConsumableArray = _npmBabelRuntime5834HelpersToConsumableArray['default'];
		}, function (_npmBabelRuntime5834CoreJsObjectKeys) {
			_Object$keys = _npmBabelRuntime5834CoreJsObjectKeys['default'];
		}, function (_srcBoxParserDom) {
			dom = _srcBoxParserDom['default'];
		}, function (_srcSource) {
			__source__ = _srcSource['default'];
		}, function (_srcBoxParserNodesImport) {
			importNode = _srcBoxParserNodesImport['default'];
		}, function (_srcBoxParserNodesExport) {
			exportNode = _srcBoxParserNodesExport['default'];
		}, function (_srcBoxParserNodesScript) {
			scriptNode = _srcBoxParserNodesScript['default'];
		}, function (_srcBoxParserNodesStyle) {
			styleNode = _srcBoxParserNodesStyle['default'];
		}, function (_srcBoxParserNodesMod) {
			modNode = _srcBoxParserNodesMod['default'];
		}],
		execute: function () {
			'use strict';

			scope = 'box';
			index = [];
			boxname = '';
			LINE_COMMENT = /^\s*\/\/.*$/gm;
			JS_COMMENT = /\/\*[^\x00]*?\*\//gm;
			meta = {};
			__boxvar__ = 'this$box';
			nodes = {
				clearMeta: function clearMeta() {
					meta = { 'import': {}, 'export': {}, local: {} };
				},
				mustreturn: false,
				lastNode: null,
				methods: [],
				pairs: {},
				routes: [],
				init: [],
				inlineThunks: [],
				body: '',
				observableKeys: [],
				delegateKeys: [],
				box: [],
				imports: [],
				exports: [],
				boxes: [],
				keys: {},

				'import': function _import(node) {
					return importNode(node, meta['import']);
				},
				'export': exportNode,
				script: scriptNode,
				//mod: modNode,
				style: styleNode,

				styles: [],
				inits: [],

				objectToArray: function objectToArray(obj) {
					return _Object$keys(obj).map(function toItem(k) {
						return obj[k];
					});
				},

				selfClosing: function selfClosing(node) {
					node.content = -1;
					return this.tag(node);
				},

				text: function text(_text) {
					return '$tree.push(' + _text + ');';
				},

				tag: function tag(node) {
					var _this = this;

					//console.log('tag-node: ' + node.name, node.body)
					this.lastNode = node;
					var isnative = dom[node.name] === node.name ? true : false;
					var mustreturn = false;
					var outerexpr = '';
					var innerexpr = '';
					var innerexprclose = '';
					var outerexprclose = '';
					var isInlineThunk = false;

					if (!node.object) node.object = {};

					node.object.attributes = [].concat(_toConsumableArray(node.attrs));
					if (node.attrs.length) {
						for (var ei in node.attrs) {
							var prop = node.attrs[ei];
							if (prop) {
								if (prop.rel && prop.rel === 'def') {

									node.jsname = toCamel(node.name);

									node.type = 'box';
									this.boxes.push(node);

									var _args = prop.value.trim();
									_args = _args ? _args.substr(0, _args.length - 1) + ')' : null;
									node.args = _args;
									var newbox = ['', ''];
									if (node.parent === 'root' || node.parent.name === 'mod') {
										//__boxvar__ = `${ node.jsname }$box`
										//newbox = [`box.set(`, `)`]
									} else {
											newbox = [node.parent.name + '.' + toCamel(node.name) + ' = ', ''];
											//newbox = [``, ``]
										}

									var _export = '';
									var _boxset = '';
									if (node.parent === 'root' || node.parent.name === 'mod') {
										//__source__(node);
										if (node.props.set || node.props.box) {
											_boxset = '\nbox(' + toCamel(node.name) + ');';
											delete node.props.set;
											delete node.props.box;
										}
										if (node.props['export']) {
											//_export = `\nbox.set(${ toCamel(node.name) }, __moduleName);\nexport `
											_export = '\nexport ';
											//_boxset = `\nbox.set('${toCamel(node.name)}', ${toCamel(node.name)});`
											delete node.props['export'];
										} else {
											///_export = `\nbox.set(${ toCamel(node.name) }, __moduleName);\n`
										}
									}
									// const $tree = []
									// $tree.push = function(e) { return this[this.length] = e }
									// function commit(...args) { return ${node.jsname}$box.commit(...args) }
									//${ toCamel(node.name) }.view = view
									outerexpr += '' + _export + newbox[0] + ' function ' + toCamel(node.name) + _args + ' {';

									if (node.parent === 'root') {

										var loads = _Object$keys(meta.local).map(function (load) {
											return 'new bitbox(' + node.jsname + '$box, ' + load + ')';
										});
										//const ${node.jsname}$box = arguments[0]
										outerexpr += '';
										outerexpr += this.inits.join('\n') + '\n';
										outerexpr += loads.join('\n') + '\n';
										this.keys = {};
										this.inits = [];
										outerexpr = outerexpr.replace(/this\$box/g, node.jsname + '$box');
										node.content = node.content.replace(/this\$box/g, node.jsname + '$box');
									}

									outerexprclose = outerexprclose + ('}' + newbox[1] + _boxset);
									delete node.props[prop.key];
								}

								switch (prop.key) {
									case 'from':
										//if (!meta.localimport)
										//	meta.localimport = {}
										node.props.from = '\'' + node.props.from.replace(/['"`]/g, '') + '/' + node.name + '!box\'';
										meta['import'][toCamel(node.name)] = node.props.from; //.replace(/['"`]/g, '')
										this.imports.push('import { ' + toCamel(node.name) + ' } from ' + node.props.from);
										delete node.props.from;
										break;
									case 'text':
										if (prop.value) node.content = '`' + node.content + '`';
										break;
									case 'if':
										outerexpr += 'if ' + prop.value + ' {';
										outerexprclose = '}';
										delete node.props['if'];
										break;
									case 'for':
										if (prop.rel === 'invoke') {
											innerexpr += 'for ' + prop.value + ' {';
											innerexprclose = '}';
											delete node.props['for'];
										}
										break;
									case 'switch':
										innerexpr += 'switch ' + prop.value + ' {';
										innerexprclose = '}';
										break;
									case 'each':
										innerexpr += prop.obj + 'forEach( ' + prop.value + ' => {';
										innerexprclose = '})';
										break;
									case 'map':
										innerexpr += prop.obj + 'map( ' + prop.value + ' => {';
										innerexprclose = '})';
										break;
									case 'route':
										var ctx = prop.value.slice(1, -1);
										var parts = ctx.split(',').map(function (x) {
											return x.trim();
										});
										var last = parts.length - 1;
										parts[last] = '(' + parts[last] + ')';
										parts.map(function (p, i) {
											if (i !== parts.length - 1) _this.routes.push(p.replace(/\'/g, '').replace(/\"/g, '').replace('[', '').replace(']', '').trim());
											return p;
										});
										outerexpr += '$route(' + parts.join(', ') + ' => {';
										outerexprclose = '})\n';
										delete node.props.route;
										break;
								}

								if (prop.key.endsWith('.map')) {
									innerexpr += prop.key + '(' + prop.value + ' => {';
									innerexprclose = '})';
									delete node.props[prop.key];
								}
								if (prop.key.endsWith('.each')) {
									innerexpr += prop.key.replace('.each', '.forEach') + '(' + prop.value + ' => {';
									innerexprclose = '})';
									delete node.props[prop.key];
								}

								if (prop.rel === 'invoke' && node.props[prop.key]) {
									node.invoke = node.name + '.' + prop.key + prop.value;
									delete node.props[prop.key];
								}
							}
						}
					}

					if (node.props.style) {
						node.props.style = normalizeStyle(node.props.style);
					}

					if (node['return']) {
						var n = '' + node.content;
						if (node.content.trim().indexOf('...') === 0) n = '' + node.content;
						node.content = '$tree.push(' + n + ');';
					}

					if (node.props['case']) {
						var caseex = 'case ' + node.props['case'] + ':';
						node.props.key = '\'case-' + node.props['case'].replace(/['"`]/g, '') + '\'';
						if (node.props['case'] === true) {
							var keys = _Object$keys(node.props);
							var caseval = keys[keys.indexOf('case') + 1];
							node.props.key = caseval;
							delete node.props[caseval];
							if (caseval === 'default') caseex = 'default:';else caseex = 'case \'' + caseval + '\':';
						}
						outerexpr = '' + caseex;
						outerexprclose = 'break;';
						delete node.props['case'];
					}

					var attrs = node.props ? '' + convertprops(node.props) : '';

					var bodyornode = '';
					var bodyornodeend = '';
					var name = node.name;

					if (node.type !== 'box') {
						//console.log('this.boxes', this.boxes)
						this.boxes.forEach(function (box) {
							if (node.name === box.name) isnative = false;
						});

						if (node.name === 'mod') {
							//console.log('mod', node)
							//node.content = `zzz`
							bodyornode = '';
							bodyornodeend = '';
						} else if (isnative) {
							name = '\'' + node.name + '\'';
							if (node.content === -1 || !node.content.trim().length) {
								node.content = '';
								var p = attrs ? ', { ' + attrs + ' }' : '';
								//bodyornode = `$tree.push(bitbox.h(${name}${p}));`
								var __bind = node.props.bit || 'this';
								bodyornode = '$tree.push(box.call(' + __bind + ', ' + name + p + '));';
								bodyornodeend = '';
							} else {
								//console.log('isString', this.isString(node.content))
								var p = attrs ? ', { ' + attrs + ' }' : ', {}';
								//bodyornode = `$tree.push(bitbox.h(${name}${p}, (function($tree) {`
								var __bind = node.props.bit || 'this';
								bodyornode = '$tree.push(box.call(' + __bind + ', ' + name + p + ', ($tree => {';
								bodyornodeend = 'return $tree })([])));';
							}
						} else {
							name = '' + toCamel(node.name);
							if (node.content === -1) {
								node.content = '';

								if (node.invoke_zz) {
									//bodyornode = `$tree.push(${ node.invoke })`
								} else {
										//name.indexOf('.') > -1 ||

										if (meta.local[name + '__s']) {
											var fnn = meta.local[name] ? name : __boxvar__ + '.' + name;
											bodyornode = '$tree.push(' + fnn + '(' + __boxvar__ + ', { ' + attrs + ' }));';
										} else {

											var key = ''; //(node.key || node.props.key || name).replace(/['"`]([^'`"]+)["'`]/g, '$1')
											if (node.key) {
												key = name; // + '$' + node.key
												node.props.key = '\'' + node.key + '\'';
											} else {
												key = name;
											}
											this.keys[key] = this.keys[key] >= 0 ? this.keys[key] + 1 : 0;
											//if (this.keys[key])
											//	key = key + '$' + this.keys[key]
											var __bind = node.props.bit || 'this';
											delete node.props.bit;
											var p = _extends({}, node.props);
											delete p[key];
											//delete p['key']
											attrs = p ? '' + convertprops(p) : '';
											if (meta['import'][name]) {
												var imn = meta['import'][name].replace('!box', ':' + key + '!box');
												this.inits.push('new bitbox(' + __boxvar__ + ', ' + name + ', { key: \'' + key + '\' })');
											}
											//const callfn = `${__boxvar__}.call('${ key }', ${__boxvar__}.${ key }, $state.${ key }, {${ attrs }}, null, commit)`
											var cr = '' + __boxvar__;
											var cb = __boxvar__ + '.' + key;
											var sk = '$state.' + key;
											//console.log('node', node)
											if (node.comprop) {
												sk = '$state' + node.comprop;
												if (node.comprop.startsWith('[')) {
													cr = '' + __boxvar__;
													cb = '' + __boxvar__ + node.comprop;
													//sk = `$state${node.comprop}`
												} else {
														cr = __boxvar__ + '.' + key;
														cb = __boxvar__ + '.' + node.comprop;
													}
												//name = node.combprop
											} else if (node.dotprop) {
													cr = __boxvar__ + '.' + key;
													cb = __boxvar__ + '.' + node.dotprop;
												}
											//const callfn = `${cr}.call(${cb}, {${ attrs }})`
											var a = attrs ? ', { ' + attrs + ' }' : ', {}';
											var callfn = cb + '.view(' + a + ', ' + sk + ')';

											node.object.key = key;
											node.object.path = cb;
											node.object.root = cr;
											node.object.props = '{' + attrs + '}';

											//bodyornode = `if (${cb}.view) { $tree.push(${ callfn }) }`
											bodyornode = '$tree.push(box.call(' + __bind + ', \'' + key + '\'' + a + '));';
										}
									}
								bodyornodeend = '';
							} else {
								//name.indexOf('.') > -1 ||
								if (meta.local[name + '__s']) {
									var fnn = meta.local[name] ? name : __boxvar__ + '.' + name;
									bodyornode = '$tree.push(' + fnn + '(' + __boxvar__ + ', { ' + attrs + ' }, ($tree => {';
									bodyornodeend = 'return $tree } )([]) ));';
								} else {
									var key = ''; //(node.key || node.props.key || name).replace(/['"`]([^'`"]+)["'`]/g, '$1')
									if (node.key) {
										key = name; // + '$' + node.key
										node.props.key = '\'' + node.key + '\'';
									} else {
										key = name;
									}
									this.keys[key] = this.keys[key] >= 0 ? this.keys[key] + 1 : 0;
									//if (this.keys[key])
									//	key = key + '$' + this.keys[key]
									var __bind = node.props.bit || 'this';
									delete node.props.bit;
									var p = _extends({}, node.props);
									delete p[key];
									//delete p['key']
									attrs = p ? '' + convertprops(p) : '';
									if (meta['import'][name]) {
										var imn = meta['import'][name].replace('!box', ':' + key + '!box');
										this.inits.push('new bitbox(' + __boxvar__ + ', ' + name + ', { key: \'' + key + '\' })');
									}
									//const callfn = `'${ key }', ${__boxvar__}.${ key }, $state.${ key }, {${ attrs }}`
									var cr = '' + __boxvar__;
									var cb = __boxvar__ + '.' + key;
									if (node.comprop) {
										if (node.comprop.startsWith('[')) {
											cr = '' + __boxvar__;
											cb = '' + __boxvar__ + node.comprop;
										} else {
											cr = __boxvar__ + '.' + key;
											cb = __boxvar__ + '.' + node.comprop;
										}
										//name = node.comprop
									} else if (node.dotprop) {
											cr = __boxvar__ + '.' + key;
											cb = __boxvar__ + '.' + node.dotprop;
										}

									var a = attrs ? ', { ' + attrs + ' }' : ', {}';
									//bodyornode = `if (${cb}.view) { $tree.push(${cb}.view(${a}, $state.${key}, (function($tree) {`

									bodyornode = '$tree.push(box.call(' + __bind + ', \'' + key + '\'' + a + ', ($tree => {';
									bodyornodeend = 'return $tree })([])));';
								}
							}
						}
					} else {

						if (node.returning) {
							bodyornode = '/** returning **/\n';
							bodyornodeend = '';
						} else {

							// if (node.name === 'view') {
							// 	let p = {
							// 		key: `${__boxvar__}.meta.path`,
							// 		...node.parent.props,
							// 		...node.props
							// 	}
							// 	delete p['export']
							// 	delete p['default']
							// 	delete p[node.parent.name]
							// 	attrs = p ? `, {${ convertprops(p)} }` : ``
							// 	bodyornode = `
							// 		const [$props,$state,$tree] = arguments;
							// 		return bitbox.h('${ node.parent.name }'${attrs}, (function($tree) {`
							// 	bodyornodeend = `return $tree }([])))`
							// } else {
							//meta.local[node.name] = {}
							//attrs = node.props ? `, { ${convertprops(node.props)} }` : ``
							var p = _extends({
								key: '\'' + node.name + '-box\''
							}, node.parent.props, node.props);
							delete p['export'];
							delete p['default'];
							delete p[node.parent.name];
							attrs = p ? ', {' + convertprops(p) + ' }' : '';
							name = '\'' + node.name + '\'';
							var nargs = node.args.replace('(', '').replace(')', '').split(',');
							//nargs.shift()
							// `return {
							// 	view(${ nargs.join(',') }) {
							// 		const [$props,$state,$tree] = arguments;`
							//${toCamel(node.name)}.view = (${ nargs.join(',') }) =>
							//${toCamel(node.name)}.view
							var en = node.props.register ? typeof node.props.register === 'string' && node.props.register.indexOf('-') > -1 ? node.props.register : '\'' + node.name + '-box\'' : '\'' + node.name + '\'';

							bodyornode = 'return new box(' + en + attrs + ', ($tree => {';
							bodyornodeend = 'return $tree })([]))';

							//bodyornode = `return (function($tree) {`
							//bodyornodeend = `return $tree } ([]) )`

							__source__({
								js: ('' + outerexpr + bodyornode + innerexpr + node.content + innerexprclose + bodyornodeend + outerexprclose).trim(),
								source: '' + node.tag + node.body + '</' + node.name + '>',
								name: '' + node.name
							});

							//}
						}
					}

					index[node.i] = typeof index[node.i] !== 'undefined' ? index[node.i] + 1 : 1;

					var keyvars = getProps(node.props, 'var');
					var args = ''; //keyvars.length ? `let { ${ keyvars.join(`, `) } } = props;` : ``

					//let bodyreturn = ''
					//let bodyreturnend = ''
					var isbody = false;

					var _imports = '',
					    _exports = '',
					    _routes = '';
					if (node.parent === 'root') {
						//__source__(node);
						if (this.imports.length) {
							_imports = '\n/* inline imports */\n' + this.imports.join('\n');
							this.imports = [];
						}
						if (this.exports.length) {
							_exports = '\n/* x */\n' + this.exports.join('\n');
							this.exports = [];
						}
						_routes = JSON.stringify(this.routes);
						_routes = _routes.substr(1, _routes.length - 2);
						_routes = _routes ? 'route.push(' + _routes + ');\n' : '';
						this.routes = [];
						this.keys = {};
					}
					// ${ _imports }
					// ${ _exports }
					var ret = '\n\t\t\t' + outerexpr + '\n\t\t\t' + bodyornode + args + innerexpr + node.content + innerexprclose + '\n\t\t\t' + bodyornodeend + '\n\t\t\t' + outerexprclose;

					return ret.trim().replace(/\n\n/g, '\n');
				},

				isString: function isString(str) {
					var strreg = /['"`]([^'`"]+)["'`]/g;
					return strreg.exec(str.trim());
				}

			};

			_export2('default', nodes);
		}
	};
});
//box: `'${node.name}'`,
System.register('src/box/parser/index', ['npm:babel-runtime@5.8.34/helpers/create-class', 'npm:babel-runtime@5.8.34/helpers/class-call-check', 'npm:babel-runtime@5.8.34/core-js/object/keys', 'npm:babel-runtime@5.8.34/core-js/get-iterator', 'src/box/parser/event', 'src/box/parser/node', 'npm:js-beautify@1.5.10'], function (_export) {
    var _createClass, _classCallCheck, _Object$keys, _getIterator, observe, transform, beautify, version, Parser;

    function Printer(parent) {
        this.parent = parent;
        this.content = '';
        this.spacer = '';
        this.indent = parent ? parent.indent : '';
        this.isFirstItem = true;
    }

    return {
        setters: [function (_npmBabelRuntime5834HelpersCreateClass) {
            _createClass = _npmBabelRuntime5834HelpersCreateClass['default'];
        }, function (_npmBabelRuntime5834HelpersClassCallCheck) {
            _classCallCheck = _npmBabelRuntime5834HelpersClassCallCheck['default'];
        }, function (_npmBabelRuntime5834CoreJsObjectKeys) {
            _Object$keys = _npmBabelRuntime5834CoreJsObjectKeys['default'];
        }, function (_npmBabelRuntime5834CoreJsGetIterator) {
            _getIterator = _npmBabelRuntime5834CoreJsGetIterator['default'];
        }, function (_srcBoxParserEvent) {
            observe = _srcBoxParserEvent['default'];
        }, function (_srcBoxParserNode) {
            transform = _srcBoxParserNode['default'];
        }, function (_npmJsBeautify1510) {
            beautify = _npmJsBeautify1510['default'];
        }],
        execute: function () {

            // the first version ;) 24 Aug
            'use strict';

            version = 0.03;
            Printer.prototype.addSpace = function (space) {
                this.spacer += space;
                if (space.indexOf("\n") !== -1) {
                    this.indent = /[^\n]*$/.exec(space)[0];
                } else {
                    this.indent += space;
                }
            };

            Printer.prototype.add = function (data, ignoreComma) {
                this.content += this.spacer;
                this.spacer = '';
                this.content += data;
            };

            Parser = (function () {
                function Parser() {
                    var _this = this;

                    var options = arguments.length <= 0 || arguments[0] === undefined ? {} : arguments[0];

                    _classCallCheck(this, Parser);

                    observe(this);

                    this.token = {};
                    this.chars = [];
                    this.index = [];
                    this.attrs = [];
                    this.props = {};
                    this.nodes = [];
                    this.text = [];
                    this.tree = {};
                    this.result = '';
                    this.node = {};

                    this.token = { '<': 1, '</': 1 };

                    var elements = [];
                    var printer = new Printer(null);

                    //this.on('run', () => {

                    printer = new Printer(null);

                    //printer.add(`/*\n\tbit!box\n\t${ (new Date).toISOString() }\n*/\n`)
                    //printer.add(`import route from 'bitbox/route'\n`)
                    //printer.add(`import $tree from 'bitbox/$tree';\n`)
                    //printer.add(`import $props from 'bitbox/$props';\n`)
                    //printer.add(`import $route from 'bitbox/$route';\n`)
                    //printer.add(`import $style from 'bitbox/$style';\n`)
                    //printer.add(`import $call from 'bitbox/$call';\n`)
                    //printer.add(`import $patch from 'bitbox/patch';\n`)
                    //printer.add(`import h from 'bitbox/h';\n`)
                    //printer.add(`import bitbox from 'bitbox/box';\n`)
                    //printer.add(`import thunk from 'bitbox/vdom/thunk';\n`)
                    //printer.add(``)
                    //printer.add(`/*\n\tthe box\n*/\n`)

                    var i = 0;
                    var isnode = false;

                    //})

                    this.on('open', function (name, node) {
                        i++;
                        if (name === '___bitbox') node.component = { key: node.attrs[0].key, attr: node.attrs };else node.component = node.parent.component;

                        if (node.tag && node.tag.endsWith('=>')) {
                            node['return'] = true;
                        }

                        elements.unshift([name, node.attrs]);
                        printer = new Printer(printer);
                        isnode = true;
                    });

                    this.on('text', function (text) {

                        var lines = text.split("\n");
                        var isFirst = true;
                        lines.forEach(function (line) {

                            var lineMatch = /^(\s*)(.*?)(\s*)$/.exec(line);
                            var preSpace = lineMatch[1],
                                mainText = lineMatch[2],
                                postSpace = lineMatch[3];

                            if (!isFirst) printer.addSpace("\n");

                            if (mainText.length > 0) {
                                var fc = mainText[0];
                                if (isnode === true && (fc === '`' || fc === "'" || fc === '"')) {
                                    printer.add(mainText);
                                } else {
                                    printer.add(mainText);
                                }
                            }
                            isFirst = false;
                        });
                    });

                    this.on('close', function (name, node) {
                        isnode = false;
                        var element = elements.shift();
                        var content = printer.content;
                        printer = printer.parent;
                        node.content = content;

                        if (typeof transform[name] === 'function') printer.add(transform[name](node));else printer.add(transform.tag(node));
                        i--;
                        //if (i === 0) this.emit('done')
                    });

                    this.on('self-closing', function (name, node) {
                        if (typeof transform[name] === 'function') printer.add(transform[name](node));else printer.add(transform.selfClosing(node));
                        //if (i === 0) this.emit('done')
                    });

                    this.on('done', function () {
                        //console.log('parser-done', printer.content);
                        //printer.content = printer.content.replace(/^\s*\n/gm, '\n')
                        _this.compiled = printer.content;
                        _this.write(_this.compiled);
                        printer = new Printer(null);
                    });

                    this.extract();
                }

                _createClass(Parser, [{
                    key: 'balanced',
                    value: function balanced() {
                        var result = arguments.length <= 0 || arguments[0] === undefined ? {} : arguments[0];
                        var pairs = arguments.length <= 1 || arguments[1] === undefined ? [] : arguments[1];

                        var s = result.out ? result.out : result.input;

                        var c = 0,
                            _o = [],
                            _c = [],
                            _x = [],
                            st = '<',
                            canclose = -1,
                            openat = 0,
                            sp = [],
                            sub = s,
                            pair = false,
                            openpos = 0,
                            closepos = 0,
                            subs = '',
                            isopen = false,
                            eqpos = 0,
                            element = {},
                            keys = [],
                            key = undefined;

                        var open = pairs.map(function (p) {
                            return p.charAt(0);
                        });
                        var close = pairs.map(function (p) {
                            return p.charAt(1);
                        });
                        var openMatch = null;
                        var closeMatch = null;
                        var currentOpen = false;

                        var subcopy = s;
                        var values = [];

                        result.pairs = {};
                        result.error = false;
                        result['return'] = false;
                        //result.attr = result.attr ? result.attr : {}
                        result.out = '';
                        result.props = result.props ? result.props : [];

                        var tagreg = /^<([^\(\s\=\/\>]+)/;
                        var tagmatch = tagreg.exec(s);
                        if (tagmatch) {
                            //console.log('tagmatch', tagmatch)
                            var _name = tagmatch[1].split(':');
                            result.name = _name[0];
                            if (result.name.indexOf('[') > -1) {
                                var rn = result.name.replace(/\[/g, '.').replace(/\]/g, '.');
                                subcopy = s = s.replace(result.name, rn);
                                result.comprop = '' + result.name;
                                result.name = rn;
                            }
                            if (result.name.indexOf('.') > -1) {
                                //result.name = result.name.split('.')[0]
                                result.dotprop = '' + result.name;
                            }
                            result.key = _name[1] || null;
                        }

                        for (var i = 0; i < s.length; i++) {
                            var ch = s.charAt(i);

                            result.pos = i;

                            if (ch === st && s.charAt(i + 1) !== '/' && canclose === -1) {
                                canclose = i;
                                openat = i;
                                //let s1 = s.substr(i+1).split(' ').shift()
                                //result.name = s1.replace('=','').replace('>','')
                            }

                            if (canclose > -1) {

                                if (!currentOpen) {
                                    var oi = open.indexOf(ch);
                                    if (oi > -1) {
                                        openMatch = ch;
                                        closeMatch = close[oi];
                                    }
                                }

                                if (ch === openMatch) {

                                    currentOpen = openMatch;
                                    c++;
                                    _o.push(i);

                                    if (!isopen) {
                                        var s1 = s.substring(0, i);
                                        var tst = s1.replace(/\s+/g, ' ').split(' ');
                                        var pk = tst.pop();
                                        key = pk.length ? pk : tst.pop() + ' ';
                                        //console.log('OPEN', result.name, key, openMatch)
                                        keys.unshift(key);
                                    }

                                    isopen = true;
                                } else if (ch === closeMatch) {

                                    c--;
                                    _c.push(i);

                                    if (c === 0) {
                                        var _key = keys.shift();
                                        var rel = _key.endsWith('=') ? 'assign' : 'invoke';

                                        if (_key.indexOf('<') === 0) {
                                            result.box = true;
                                            _key = _key.substr(1);
                                            rel = 'def';
                                        }
                                        var type = openMatch + closeMatch;

                                        currentOpen = false;
                                        openMatch = null;
                                        closeMatch = null;

                                        isopen = false;
                                        openpos = _o.shift();
                                        closepos = _c.pop();
                                        var value = s.substring(openpos, closepos + 1);
                                        //console.log('CLOSE'.bgRed, result.name.bgGreen, key.bgBlue, value.bgGreen)

                                        result.__i = result.props.push({
                                            key: _key.trim().replace('=', ''),
                                            value: value, type: type, rel: rel
                                        });

                                        subcopy = subcopy.replace(_key + value, result.__i);
                                        //console.log('CLOSE', result.name, key, type, value)
                                        //console.log('SUBCOPY', subcopy)
                                        _o = [];
                                        _c = [];
                                    } else {
                                        //openpos = _o.shift()
                                        //closepos = _c.pop()
                                        //console.log('ERROR', key)
                                        //console.log('RESULT', result)
                                        // result.error = {
                                        //     type: 'unbalanced',
                                        //     input: s.substring(openpos, closepos + 1)
                                        // }
                                        // return result
                                    }
                                    if (c < 0) {
                                        result.error = 'c < 0';
                                        return result;
                                    }
                                }
                                if (ch === '>') {
                                    if (c === 0) {
                                        if (s[i - 1] === '=') result['return'] = true;

                                        if (s[i - 1] === '/') result.selfClosing = true;

                                        var tag = s.substring(canclose, i + 1);
                                        result.tag = tag;
                                        //console.log(result.name.bgRed + tag.bgYellow)

                                        subcopy = subcopy.substring(openat + 1, i);
                                        //console.log('subcopy>>>>>>>>', subcopy)

                                        subcopy = subcopy.split('>').shift().trim();
                                        if (result['return'] || result.selfClosing) subcopy = subcopy.substring(0, subcopy.length - 1).trim();

                                        canclose = 0;
                                        result.out = subcopy.replace(/\s+/g, ' ').trim();
                                        return result;
                                    } else {
                                        //console.log('\nIGNORE '.red, s.substring(openat, i).bgYellow + '>'.bgRed)
                                    }
                                }
                            }
                        }
                        if (c === 0) return result;
                        result.error = 'c !== 0';
                        return result;
                    }
                }, {
                    key: 'extract',
                    value: function extract() {
                        var _this2 = this;

                        var i = 0,
                            node = null,
                            roots = 0,
                            frompos = 0;

                        this.on('<', function (pos, tok) {

                            //if (pos < frompos) return

                            var str = _this2.string(pos);
                            if (str.indexOf('</') === 0) return;
                            //if (str[0] === ' ') return

                            // let tagreg = /^<([\w\-]+)[^>]+>/
                            // let tagmatch = tagreg.exec(str)
                            // if (!tagmatch) {
                            //     //console.log("tagmatch", tagmatch[1].bgRed, tagmatch[0].bgYellow)
                            //     console.log("!tagmatch", str.substr(0, 50))
                            //     this.emit('error', pos)
                            //     return false
                            // } else {
                            //     //console.log("tagmatch".bgGreen, tagmatch[1].bgMagenta, tagmatch[0].bgYellow)
                            // }

                            var innerpos = pos + tok.length;
                            var innerstr = str.slice(innerpos);
                            var props = {};

                            var a = str;

                            var b = null;

                            if (a.length) {

                                b = _this2.balanced({ input: a, __i: 0 }, ['()', '{}', '[]']);

                                b.out = b.out.replace(/([\w\-]+)\s?=?\s?['"`]([^'`"]+)["'`]/g, function (match, key, value) {
                                    var type = 'static';
                                    if (key === 'class') {
                                        value = '{' + value.split(' ').map(function (c) {
                                            return '\'' + c + '\': true';
                                        }).join(', ') + '}';
                                        type = '{}';
                                    }
                                    b.__i = b.props.push({ key: key, value: value, type: type, rel: 'assign' });
                                    return b.__i;
                                });

                                frompos = pos + b.pos;
                                if (b.out.startsWith(b.name)) b.out = b.out.substr(b.name.length);

                                b.out = b.out.trim();
                                var c = b.out.split(' ').map(function (i) {
                                    var index = parseInt(i);
                                    if (index) {
                                        return b.props[index - 1];
                                    } else if (i.length) {
                                        var reg = /[^A-Za-z0-9-]/;
                                        var v = i.split('=');
                                        if (v.length === 2) {
                                            return { key: v[0], value: v[1], type: 'value' };
                                        }
                                        if (i.indexOf('...') === 0) return { key: i, type: 'spread' };
                                        if (i.startsWith('+') || i.startsWith('-')) return { key: i.substr(1), value: i[0] === '+' ? 1 : 0, type: '10' };
                                        return { key: i, value: i, type: 'keyed' };
                                    } else {
                                        return null;
                                    }
                                });
                                b.props = c;
                                //console.log('balanced', JSON.stringify(b, null, 4))
                                //console.log('\n' + '-'.repeat(100), '\n')
                            }

                            if (b && b.name && !b.error) {
                                (function () {

                                    var tag = b.tag || '';
                                    var name = b.name;
                                    var key = b.key;
                                    var attrs = b.props;
                                    var props = {};

                                    attrs.forEach(function (attr, i) {
                                        if (attr) if (attr.key === ':' + key) delete b.props[i];else props[attr.key] = attr.type === 'static' ? '\'' + attr.value + '\'' : attr.value;
                                    });

                                    var parent = _this2.index[_this2.index.length - 1] ? _this2.index[_this2.index.length - 1] : 'root';
                                    node = { i: i, tag: tag, name: name, key: key, attrs: attrs, props: props, parent: parent, start: { pos: pos, tok: tok } };
                                    node.type = b.selfClosing ? 'self-closing' : 'normal';
                                    node.box = b.box;
                                    node.name = node.name ? node.name.match(/([a-z-0-9]+)/)[1] : node.name;
                                    node.camelName = _this2.toCamel(node.name);
                                    node.comprop = b.comprop;
                                    node.dotprop = b.dotprop;

                                    //console.log('node', node)

                                    if (_this2.text.length) {
                                        var text = _this2.text.pop();
                                        if (text) _this2.emit('text', _this2.string(text, pos));
                                    }

                                    _this2.node = node;

                                    if (b.selfClosing) {
                                        node.body = null;
                                        _this2.emit('self-closing', name, node);
                                        _this2.emit('node', node);
                                    } else {
                                        _this2.index.push(node);
                                        _this2.emit('open', name, node);
                                        _this2.text.push(pos + tag.length);
                                    }

                                    i++;
                                })();
                            }
                        });

                        this.on('</', function (pos, tok) {

                            var start = _this2.index.pop();

                            if (start) {
                                var _close = _this2.string(pos, pos + tok.length + start.name.length + 1);
                                if (_close === '</' + start.name + '>') {
                                    i--;
                                    node = start;
                                } else {
                                    node = null;
                                    _this2.index.push(start);
                                }
                            }

                            if (node) {
                                node.body = _this2.string(node.start.pos + node.tag.length, pos);

                                if (node.box) {
                                    //node.returning = 1
                                    var retreg = /(.+return([^<\/>]+)<\/>)/gm;
                                    var isret = retreg.exec(node.body + '</>');
                                    if (isret) {
                                        node.returning = isret[2].trim();
                                    }
                                }

                                node.end = { pos: pos, tok: tok };
                                node.type = 'normal';
                                if (_this2.text.length) {
                                    var text = _this2.text.pop();
                                    if (text) _this2.emit('text', _this2.string(text, pos));
                                }
                                _this2.text.push(pos + tok.length + node.name.length + 1);
                                _this2.emit('close', node.name, node);
                                _this2.emit('node', node);
                            }
                        });
                    }
                }, {
                    key: 'toCamel',
                    value: function toCamel(subj, all) {
                        if (subj && subj.indexOf('-') > -1) {
                            var parts = subj.split('-');
                            subj = parts.map(function (p, i) {
                                return !all && i === 0 ? p : p.substr(0, 1).toUpperCase() + p.substr(1);
                            }).join('');
                        }
                        return !all ? subj : subj.substr(0, 1).toUpperCase() + subj.substr(1);
                    }
                }, {
                    key: 'exprattr',
                    value: function exprattr(str) {
                        str = str.replace(/\n/g, ' ').replace(/\t/g, '').trim();
                        var re = /((\w+\.)+)?(\w+)\s?(\([^)]+\))/gi; ///(\w+)\s?(\([^)]+\))([\s\/\>])/gi;
                        var exprs = [];
                        var result = str.replace(re, function (m, obj, iobj, type, expr, s) {
                            exprs.push({ type: type, expr: expr, obj: obj });
                            return '';
                        });
                        return { result: result, exprs: exprs };
                    }
                }, {
                    key: 'string',
                    value: function string(a, b) {
                        if (typeof a === 'string') {
                            this._string = a; //.replace(/\n/g, ' ').replace(/\t/g, '').trim()
                            this.result = this._string;
                            return this._string;
                        }
                        return this._string.slice(a, b);
                    }
                }, {
                    key: 'update',
                    value: function update(payload, value) {
                        var _this3 = this;

                        var diff = {};

                        if (value && typeof payload === 'string') {
                            var key = payload;
                            payload = {};
                            payload[key] = value;
                        }
                        if (payload && typeof payload === 'object') {
                            _Object$keys(payload).map(function (k) {
                                if (_this3[k] !== payload[k]) {
                                    diff[k] = {
                                        old: _this3[k],
                                        'new': payload[k]
                                    };
                                    _this3[k] = payload[k];
                                }
                            });
                        }

                        this.emit('update', payload, diff);
                    }
                }, {
                    key: 'run',
                    value: function run() {
                        var _this4 = this;

                        // this.chars = []
                        // this.index = []
                        // this.attrs = []
                        // this.props = {}
                        // this.nodes = []
                        // this.text = []
                        // this.tree = {}

                        this.chars = [];
                        this.index = [];
                        this.attrs = [];
                        this.props = {};
                        this.nodes = [];
                        this.text = [];
                        this.tree = {};
                        this.result = '';
                        this.compiled = '';

                        this.emit('run', this.token);

                        var string = this.string(0);

                        var _iteratorNormalCompletion = true;
                        var _didIteratorError = false;
                        var _iteratorError = undefined;

                        try {
                            var _loop = function () {
                                var char = _step.value;

                                var index = _this4.chars.push(char) - 2;

                                if (char !== '"' && char !== '`' && char !== '\'') {
                                    _Object$keys(_this4.token).forEach(function (token) {

                                        var s = _this4.string(index).startsWith(token);

                                        if (s === true) {
                                            _this4.emit(token, index, token);
                                        }
                                    });
                                }
                            };

                            for (var _iterator = _getIterator(string), _step; !(_iteratorNormalCompletion = (_step = _iterator.next()).done); _iteratorNormalCompletion = true) {
                                _loop();
                            }
                        } catch (err) {
                            _didIteratorError = true;
                            _iteratorError = err;
                        } finally {
                            try {
                                if (!_iteratorNormalCompletion && _iterator['return']) {
                                    _iterator['return']();
                                }
                            } finally {
                                if (_didIteratorError) {
                                    throw _iteratorError;
                                }
                            }
                        }

                        this.emit('done');
                        return this.compiled;
                    }
                }, {
                    key: 'fromString',
                    value: function fromString(content, fn) {
                        this.fn = fn;
                        this.source = content;
                        //let a = content //.replace(/\s+/g, ' ') //.trim()
                        //let eqreg = /(\s+)?(\=)(\s+)?/g
                        //a = a.replace(eqreg, '=')
                        this.string(content);
                        this.emit('ready');
                        return this.run();
                    }
                }, {
                    key: 'parse',
                    value: function parse(content, fn) {
                        transform.clearMeta();
                        transform.boxes = [];
                        this.fn = fn;
                        //let eqreg = /(\s+)?(\=)(\s+)?/g
                        //content = content.replace(eqreg, '=')
                        this.source = content;
                        this.string(content);
                        this.emit('ready');
                        this.run();
                        //this.compiled = this.compiled.replace(/^\s*[\r\n]/gm, '')
                        if (typeof fn === 'function') return fn.call(null, this.source, this.compiled);
                        return beautify(this.compiled, {
                            indent_with_tabs: true,
                            indent_size: 4
                        });
                        //return this.compiled
                    }
                }, {
                    key: 'transform',
                    value: function transform(code) {
                        return {
                            code: this.parse('<mod>' + code + '</mod>'),
                            node: this.node
                        };
                    }
                }, {
                    key: 'write',
                    value: function write(content) {
                        if (typeof this.fn === 'function') this.fn.call(null, this.source, content);
                    }
                }]);

                return Parser;
            })();

            _export('default', Parser);
        }
    };
});
System.register("src/box/parser", ["src/box/parser/index"], function (_export) {
    "use strict";

    var parser;

    _export("default", parse);

    function parse(source, options) {
        // count.box(<xxx(b) => b.value + ccc())
        source = source.replace(/(\()(<([a-z0-9-]+)(.*)=>([^\n</]+))(\))$/gm, "(<$3$4=>$5</$3>)");
        //
        source = source.replace(/<([a-z0-9-]+)(.*)=>([^\n</]+)$/gm, "<$1$2=>$3</$1>");
        var result = new parser().transform(source, options);

        result.code = result.code.replace(/exportfunction/g, 'export function');
        result.code = result.code.replace(/\;\)/g, '\)');
        return result;
    }

    return {
        setters: [function (_srcBoxParserIndex) {
            parser = _srcBoxParserIndex["default"];
        }],
        execute: function () {}
    };
});
System.register('src/box', ['npm:babel-runtime@5.8.34/helpers/slice', 'npm:babel-runtime@5.8.34/helpers/bind', 'npm:babel-runtime@5.8.34/helpers/to-consumable-array', 'npm:babel-runtime@5.8.34/core-js/object/create', 'npm:babel-runtime@5.8.34/core-js/promise', 'npm:babel-runtime@5.8.34/core-js/object/get-own-property-descriptor', 'npm:babel-runtime@5.8.34/core-js/object/define-property', 'npm:babel-runtime@5.8.34/core-js/symbol', 'src/box/parser', 'src/box/patch', 'src/bit/is', 'src/box/color', 'src/source'], function (_export) {
    var _slice, _bind, _toConsumableArray, _Object$create, _Promise, _Object$getOwnPropertyDescriptor, _Object$defineProperty, _Symbol, parser, patch, is, color, getsrc, headEl, ie, seen, internalRegistry, externalRegistry, anonymousEntry;

    function box(name) {
        var _box$get;

        for (var _len = arguments.length, args = Array(_len > 1 ? _len - 1 : 0), _key = 1; _key < _len; _key++) {
            args[_key - 1] = arguments[_key];
        }

        //if (this instanceof bit)
        //    console.log('bit instance', this)

        if (this instanceof box) {
            var node = new (_bind.apply(box.node, [null].concat(_slice.call(arguments))))();
            this.key = name + '-box';
            this.sel = name;
            this.elm = undefined;
            this.data = node.data || _Object$create(null);
            this.children = node.children;
            return this;
        } else if (typeof name === 'object') {
            // patch
            var prop = Array.prototype.slice.call(arguments);
            var node = prop.shift();
            var bxfn = prop.shift();
            return box.patch(node, bxfn.apply(undefined, _toConsumableArray(prop)));
        } else if (typeof name === 'function') {
            return box.set(name);
        } else if (typeof name === 'string') if (box.has(name)) return (_box$get = box.get(name)).call.apply(_box$get, [this].concat(args));else return new (_bind.apply(box.node, [null].concat(_slice.call(arguments))))();
    }

    /*
      normalizeName() is inspired by Ember's loader:
      https://github.com/emberjs/ember.js/blob/0591740685ee2c444f2cfdbcebad0bebd89d1303/packages/loader/lib/main.js#L39-L53
     */
    function normalizeName(child, parentBase) {
        if (child.charAt(0) === '/') {
            child = child.slice(1);
        }
        if (child.charAt(0) !== '.') {
            return child;
        }
        var parts = child.split('/');
        while (parts[0] === '.' || parts[0] === '..') {
            if (parts.shift() === '..') {
                parentBase.pop();
            }
        }
        return parentBase.concat(parts).join('/');
    }

    function ensuredExecute(name) {
        var mod = internalRegistry[name];
        if (mod && !seen[name]) {
            seen[name] = true;
            // one time operation to execute the module body
            mod.execute();
        }
        return mod && mod.proxy;
    }

    function set(name, values) {
        externalRegistry[name] = values;
    }

    function get(name) {
        return externalRegistry[name] || ensuredExecute(name);
    }

    function has(name) {
        return !!externalRegistry[name] || !!internalRegistry[name];
    }

    //box.set('abc', 'host.com/pkg:key')

    function createScriptNode(src, callback) {
        var node = document.createElement('script');
        // use async=false for ordered async?
        // parallel-load-serial-execute http://wiki.whatwg.org/wiki/Dynamic_Script_Execution_Order
        if (node.async) {
            node.async = false;
        }
        if (ie) {
            node.onreadystatechange = function () {
                if (/loaded|complete/.test(this.readyState)) {
                    this.onreadystatechange = null;
                    callback();
                }
            };
        } else {
            node.onload = node.onerror = callback;
        }
        node.setAttribute('src', src);
        headEl.appendChild(node);
    }

    function load(name) {
        return new _Promise(function (resolve, reject) {
            createScriptNode(name + '.js', function (err) {
                if (anonymousEntry) {
                    box.register(name, anonymousEntry[0], anonymousEntry[1]);
                    anonymousEntry = undefined;
                }
                var mod = internalRegistry[name];
                if (!mod) {
                    reject(new Error('Error loading module ' + name));
                    return;
                }
                _Promise.all(mod.deps.map(function (dep) {
                    if (externalRegistry[dep] || internalRegistry[dep]) {
                        return _Promise.resolve();
                    }
                    return load(dep);
                })).then(resolve, reject);
            });
        });
    }

    return {
        setters: [function (_npmBabelRuntime5834HelpersSlice) {
            _slice = _npmBabelRuntime5834HelpersSlice['default'];
        }, function (_npmBabelRuntime5834HelpersBind) {
            _bind = _npmBabelRuntime5834HelpersBind['default'];
        }, function (_npmBabelRuntime5834HelpersToConsumableArray) {
            _toConsumableArray = _npmBabelRuntime5834HelpersToConsumableArray['default'];
        }, function (_npmBabelRuntime5834CoreJsObjectCreate) {
            _Object$create = _npmBabelRuntime5834CoreJsObjectCreate['default'];
        }, function (_npmBabelRuntime5834CoreJsPromise) {
            _Promise = _npmBabelRuntime5834CoreJsPromise['default'];
        }, function (_npmBabelRuntime5834CoreJsObjectGetOwnPropertyDescriptor) {
            _Object$getOwnPropertyDescriptor = _npmBabelRuntime5834CoreJsObjectGetOwnPropertyDescriptor['default'];
        }, function (_npmBabelRuntime5834CoreJsObjectDefineProperty) {
            _Object$defineProperty = _npmBabelRuntime5834CoreJsObjectDefineProperty['default'];
        }, function (_npmBabelRuntime5834CoreJsSymbol) {
            _Symbol = _npmBabelRuntime5834CoreJsSymbol['default'];
        }, function (_srcBoxParser) {
            parser = _srcBoxParser['default'];
        }, function (_srcBoxPatch) {
            patch = _srcBoxPatch['default'];
        }, function (_srcBitIs) {
            is = _srcBitIs['default'];
        }, function (_srcBoxColor) {
            color = _srcBoxColor['default'];
        }, function (_srcSource) {
            getsrc = _srcSource.get;
        }],
        execute: function () {
            /** [bit!box] v1.0 MIT License
            	(by Sergiu Toderascu http://bitbox.pub)
            	*/

            'use strict';

            _export('default', box);

            box.patch = function (a, b) {
                try {
                    return patch(a, b);
                } catch (e) {
                    console.warn('box.patch', e);
                }
            };

            box.color = color;

            box.src = function (n) {
                return getsrc(n);
                console.warn('box.src', n.name, n.tag);
                //console.log(n);
            };

            box.parse = function (c, x) {
                if (!c) throw new Error('Invalid arguments');

                if (typeof c === 'string') {
                    if (c.indexOf('#') === 0) {
                        var elm = document.querySelector(c);
                        c = parser(elm.textContent.trim());
                    } else {
                        c = parser(c);
                    }
                    return x ? c : c.code;
                }
                if (typeof c === 'object') {
                    var s = c[0];
                    for (var i = 1; i < arguments.length; i++) {
                        var arg = String(arguments[i]);
                        s += arg.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
                        s += c[i];
                    }
                    return parser(s).code;
                }
            };

            box.__eval = function (s) {
                try {
                    var code = parser(s).code;
                    if (code) {
                        eval('(function() {\n                    var $tree = [];\n                    $tree.push = function(n) {\n                        return this[this.length] = n\n                    };\n                    ' + code + '\n                }())');
                    }
                } catch (e) {
                    console.warn(e);
                }
            };

            headEl = document.getElementsByTagName('head')[0];
            ie = /MSIE/.test(navigator.userAgent);
            seen = _Object$create(null);
            internalRegistry = _Object$create(null);
            externalRegistry = _Object$create(null);
            anonymousEntry = undefined;
            box['delete'] = function (name) {
                return delete externalRegistry[name] && delete internalRegistry[name];
            };box.set = function (a, b, c) {

                if (typeof a === 'string' && typeof b === 'function') set(a, b);else if (typeof a === 'function' && a.name) set(a.name, a);else if (typeof a === 'object' && a.raw) {
                    var code = box.parse(a.raw);
                    if (code) {
                        if ('js_beautify' in window) code = js_beautify(code);
                        try {
                            eval(code);
                        } catch (e) {
                            console.warn('box.set', e);
                        }
                    }
                    if (c) return code;
                }
            };

            box.get = get;
            box.has = has;

            box.fetch = function (x) {
                return fetch(x + '.box').then(function (req) {
                    return req.text();
                }).then(function (text) {
                    try {
                        var code = box.parse(text);
                        if ('js_beautify' in window) code = js_beautify(code);
                        return _Promise.resolve(code);
                        //eval(code)
                    } catch (e) {
                        console.warn('fetch', e);
                    }
                });
            };

            box['import'] = function (name) {
                return new _Promise(function (resolve, reject) {
                    var normalizedName = normalizeName(name, []);
                    var mod = get(normalizedName);
                    return mod ? resolve(mod) : load(name).then(function () {
                        return get(normalizedName);
                    });
                });
            };

            box.register = function (name, deps, wrapper) {
                if (Array.isArray(name)) {
                    // anounymous module
                    anonymousEntry = [];
                    anonymousEntry.push.apply(anonymousEntry, arguments);
                    return; // breaking to let the script tag to name it.
                }
                var proxy = _Object$create(null),
                    values = _Object$create(null),
                    mod,
                    meta;
                // creating a new entry in the internal registry
                internalRegistry[name] = mod = {
                    // live bindings
                    proxy: proxy,
                    // exported values
                    values: values,
                    // normalized deps
                    deps: deps.map(function (dep) {
                        return normalizeName(dep, name.split('/').slice(0, -1));
                    }),
                    // other modules that depends on this so we can push updates into those modules
                    dependants: [],
                    // method used to push updates of deps into the module body
                    update: function update(moduleName, moduleObj) {
                        meta.setters[mod.deps.indexOf(moduleName)](moduleObj);
                    },
                    execute: function execute() {
                        mod.deps.map(function (dep) {
                            var imports = externalRegistry[dep];
                            if (imports) {
                                mod.update(dep, imports);
                            } else {
                                imports = get(dep) && internalRegistry[dep].values; // optimization to pass plain values instead of bindings
                                if (imports) {
                                    internalRegistry[dep].dependants.push(name);
                                    mod.update(dep, imports);
                                }
                            }
                        });
                        meta.execute();
                    }
                };
                // collecting execute() and setters[]
                meta = wrapper(function (identifier, value) {
                    values[identifier] = value;
                    mod.lock = true; // locking down the updates on the module to avoid infinite loop
                    mod.dependants.forEach(function (moduleName) {
                        if (internalRegistry[moduleName] && !internalRegistry[moduleName].lock) {
                            internalRegistry[moduleName].update(name, values);
                        }
                    });
                    mod.lock = false;
                    if (!_Object$getOwnPropertyDescriptor(proxy, identifier)) {
                        _Object$defineProperty(proxy, identifier, {
                            enumerable: true,
                            get: function get() {
                                return values[identifier];
                            }
                        });
                    }
                    return value;
                });
            };

            box.node = function (a, b, c) {

                if (this instanceof box.node === false) return new box.node(a, b, c);
                //        throw new Error('Please use new operator for box.node constructor');

                this.sel = box.node.text === a ? undefined : a;
                this.key = b ? b.key : undefined;
                this.elm = undefined;
                this.children = undefined;
                this.data = _Object$create(null);

                if (arguments.length === 3) {
                    if (is.object(b)) this.data = b;

                    if (is.array(c)) this.children = c;else if (is.primitive(c)) this.text = c;
                } else if (arguments.length === 2) {
                    if (a === box.node.text || is.primitive(b)) this.text = b;else if (is.array(b)) this.children = b;else if (is.object(b)) this.data = b;
                }

                if (is.array(this.children)) {
                    for (var i = 0; i < this.children.length; ++i) {
                        if (is.primitive(this.children[i])) this.children[i] = new box.node(box.node.text, this.children[i]);
                    }
                }
            };

            box.node.text = _Symbol('[box[node/text]]');
            box.node.element = _Symbol('[box[node/element]]');
        }
    };
});
System.register('src/bit', ['npm:babel-runtime@5.8.34/helpers/define-property', 'npm:babel-runtime@5.8.34/helpers/extends', 'npm:babel-runtime@5.8.34/helpers/slice', 'npm:babel-runtime@5.8.34/helpers/bind', 'npm:babel-runtime@5.8.34/core-js/map', 'npm:babel-runtime@5.8.34/core-js/weak-map', 'npm:babel-runtime@5.8.34/core-js/symbol', 'npm:babel-runtime@5.8.34/core-js/object/create', 'npm:babel-runtime@5.8.34/core-js/object/define-property', 'npm:babel-runtime@5.8.34/core-js/promise', 'src/bit/is', 'src/box', 'src/store', 'src/box/patch'], function (_export) {
	var _defineProperty, _extends, _slice, _bind, _Map, _WeakMap, _Symbol, _Object$create, _Object$defineProperty, _Promise, is, box, store, patch, __bitmap, __submap, __recmap, __BXS, IDX, vnodes, __BIDX, __VNODES, oldbox;

	//args = Array.prototype.slice.call(arguments)
	function subscribers(object) {
		if (!__submap.has(object)) __submap.set(object, {});
		var m = __submap.get(object);
		m['fns'] = m['fns'] || [];
		return m['fns'];
	}

	function record(b, p) {
		var records = __recmap.get(b.meta.i);
		if (records) {
			console.log('[bit/rec]', b.meta.x, records.push(p));
			return record;
		}
	}

	function bit() {
		if (!(this instanceof bit)) return new (_bind.apply(bit, [null].concat(_slice.call(arguments))))();

		var _arguments = _slice.call(arguments);

		var __pub = _arguments[0];
		var __sub = _arguments[1];

		if (is.primitive(__pub)) __pub = { value: __pub };

		if (!__pub || !__pub.meta) {
			/// no meta, new bit, define initial metadata
			Object.defineProperty(this, 'meta', { value: _Object$create(null) });
			this.meta.i = ++IDX;
			this.meta.v = 0;
			this.meta.p = 0;
			this.meta.k = 'top';
			this.meta.b = undefined;
			// Object.defineProperty(this, 'meta', {
			// 	value: { i: ++IDX, v: 0, p: 0, k: 'top', b: undefined }
			// })
		}

		var id = this.meta ? this.meta.i : __pub.meta.i;

		for (var prop in __pub) {
			var desc = __pub[prop];
			if (desc !== bit.remove) {
				if (desc instanceof bit) {
					Object.defineProperty(desc.meta, 'k', { value: prop });
					Object.defineProperty(desc.meta, 'p', { value: id });
				}
				_Object$defineProperty(this, prop, {
					value: desc,
					enumerable: prop !== 'meta'
				});
			}
		}

		__bitmap.set(id, this);

		//if (__sub) this.sub(__sub(this))
		if (__sub) this.sub((function sync(b) {
			__sub(b);
			return sync;
		})(this));
	}

	function __bp(key, node, target) {
		if (key in vnodes) {
			vnodes[key] = box.patch(vnodes[key], node);
		} else {
			var temp = document.createElement('span');
			target.appendChild(temp);
			vnodes[key] = box.patch(temp, node);
		}
	}

	function __bb(a, b, c) {
		return new _Promise(function (resolve, reject) {
			if (!box.has(a)) {
				b.box(a, bit.remove);
				reject(new Error(a + ' box not found'));
				return;
			}
			try {
				var __bx = box.get(a);
				__bp(a, __bx(b), document.body);
				resolve();
			} catch (e) {
				console.warn('bit!box', a, b.meta);
				//b.box(a, bit.remove)
				reject(e);
			}
		});
	}

	// bit.prototype.rec = function rec() {
	//
	// 	const a = arguments[0]
	// 	const i = this.meta.i
	//
	// 	if (typeof a === 'undefined') {
	// 		//console.log('[bit/rec:get]', i)
	// 		return __recmap.get(i)
	// 	}
	// 	if (a === bit.remove) {
	// 		//const r = this.sub(record, bit.remove)
	// 		//console.log('[bit/rec:delete]')
	// 		return __recmap.delete(i)
	// 	}
	// 	if (a === 1) {
	// 		__recmap.set(i, [])
	// 		console.log('[bit/rec:start]', i)
	// 		return this.sub(record)
	// 	}
	// 	if (a === 0) {
	// 		this.sub(record, bit.remove)
	// 		const records = __recmap.get(i)
	// 		const duration = records[records.length-1].time - records[0].time
	// 		console.log('[bit/rec:stop]', { duration, length: records.length })
	// 		return records
	// 	}
	//
	// }

	// bit.prototype.map = function map(fn) {
	// 	return Object.keys(this).map(k => fn(this[k], k))
	// }

	function old$box(b, target) {

		target = target || document.body;

		if (!b || !target) throw 'Invalid arguments provided';

		this.sub(invoke(b.name, target));
		this.pub();

		function invoke(name, target) {
			var vnode = undefined;
			function render(state) {
				if (state === bit.remove) {
					var remove = function remove() {
						vnode.elm.remove();
						vnode = undefined;
					};

					if (vnode.data.hook && vnode.data.hook.remove) vnode.data.hook.remove(vnode, remove);else remove();
					return;
				}
				var node = box[name](state);
				if (vnode) {
					vnode = box.patch(vnode, node);
				} else {
					var elm = document.createElement('span');
					target.appendChild(elm);
					vnode = box.patch(elm, node);
				}
				return render;
			}
			return render;
		}
		return this;
	}

	return {
		setters: [function (_npmBabelRuntime5834HelpersDefineProperty) {
			_defineProperty = _npmBabelRuntime5834HelpersDefineProperty['default'];
		}, function (_npmBabelRuntime5834HelpersExtends) {
			_extends = _npmBabelRuntime5834HelpersExtends['default'];
		}, function (_npmBabelRuntime5834HelpersSlice) {
			_slice = _npmBabelRuntime5834HelpersSlice['default'];
		}, function (_npmBabelRuntime5834HelpersBind) {
			_bind = _npmBabelRuntime5834HelpersBind['default'];
		}, function (_npmBabelRuntime5834CoreJsMap) {
			_Map = _npmBabelRuntime5834CoreJsMap['default'];
		}, function (_npmBabelRuntime5834CoreJsWeakMap) {
			_WeakMap = _npmBabelRuntime5834CoreJsWeakMap['default'];
		}, function (_npmBabelRuntime5834CoreJsSymbol) {
			_Symbol = _npmBabelRuntime5834CoreJsSymbol['default'];
		}, function (_npmBabelRuntime5834CoreJsObjectCreate) {
			_Object$create = _npmBabelRuntime5834CoreJsObjectCreate['default'];
		}, function (_npmBabelRuntime5834CoreJsObjectDefineProperty) {
			_Object$defineProperty = _npmBabelRuntime5834CoreJsObjectDefineProperty['default'];
		}, function (_npmBabelRuntime5834CoreJsPromise) {
			_Promise = _npmBabelRuntime5834CoreJsPromise['default'];
		}, function (_srcBitIs) {
			is = _srcBitIs['default'];
		}, function (_srcBox) {
			box = _srcBox['default'];
		}, function (_srcStore) {
			store = _srcStore['default'];
		}, function (_srcBoxPatch) {
			patch = _srcBoxPatch['default'];
		}],
		execute: function () {
			/** [bit!box] v1.0 MIT License
   	(by Sergiu Toderascu http://bitbox.pub)
   	*/

			'use strict';

			_export('default', bit);

			__bitmap = new _Map();
			__submap = new _WeakMap();
			__recmap = new _Map();
			__BXS = {};
			IDX = 0;
			bit.symbol = _Symbol('[bit!...]');
			bit.version = 1;
			bit.remove = _Symbol('bit.remove');

			bit.prototype.pub = function () {
				var _this = this;

				for (var _len = arguments.length, b = Array(_len), _key = 0; _key < _len; _key++) {
					b[_key] = arguments[_key];
				}

				if (this instanceof bit === false) throw new Error('Cannot publish, invalid bit instance');

				return new _Promise(function (resolve) {

					var state = undefined;
					if (b.length === 1) if (is.primitive(b[0])) state = { value: b[0] };else state = b[0];

					if (b.length > 1 && typeof b[0] === 'string') state = _defineProperty({}, b[0], b[1]);

					var c = b[2] || { path: [], time: Date.now(), pub: state, id: _this.meta.i };
					if (_this.meta.k) c.path.push(_this.meta.k);

					var obit = _this;
					var nbit = new bit(_extends({}, obit, state, { meta: _extends({}, obit.meta, {
							v: obit.meta.v + 1,
							x: c.path
						}) }));

					new _Promise(function () {
						return obit.sub(bit.remove).forEach(function (fn) {
							return nbit.sub(fn(nbit, c));
						});
					});

					if (nbit.meta.b) _Promise.all(nbit.meta.b.map(function (n) {
						return __bb(n, nbit);
					}));

					if (_this.meta.i in __BXS) {
						var bxs = __BXS[_this.meta.i];
						bxs.forEach(function (bx, idx) {
							return bx[1] = box.patch(bx[1], bx[0].call(nbit, {}));
						});
					}

					/// publish to parent
					if (__bitmap.has(obit.meta.p)) __bitmap.get(obit.meta.p).pub(obit.meta.k, nbit, c).then(function (_p) {
						return resolve(_p[obit.meta.k], c);
					});else resolve(nbit, c);
				});
			};

			bit.bxs = function () {
				return __BXS;
			};

			bit.prototype.box = function (bx) {
				var qs = arguments.length <= 1 || arguments[1] === undefined ? 'app' : arguments[1];

				if (!__BXS[this.meta.v]) __BXS[this.meta.i] = [];

				if (typeof bx === 'string') bx = eval('(function(){ return ' + box.parse(bx) + ' })()');
				if (typeof bx !== 'function') throw new Error('Invalid box');

				var elm = qs instanceof Element ? qs : document.querySelector(qs);

				var temp = document.createElement('span');
				elm.appendChild(temp);

				var name = elm.localName;
				var node = box.patch(temp, bx.call(this, this));

				// box(name, {
				// 	style: {
				// 		display: 'block',
				// 		border: '1px solid ' + box.color()
				// 	}
				// }, [bx(this)]))

				__BXS[this.meta.i].push([bx, node]);
				return this;
			};

			vnodes = {};
			__BIDX = 0;
			__VNODES = {};

			oldbox = function oldbox() {

				var a = arguments[0];
				var b = arguments[1] || document.body;

				if (typeof a === 'string') a = eval('(function(){ return ' + box.parse(a) + ' })()');

				var name = a.name || 'b' + ++__BIDX;

				box.set(name, a);

				if (!box.has(name)) throw new Error(name + ' box not found');

				if (this.meta.b) {
					var idx = this.meta.b.indexOf(name);
					if (idx > -1) {
						if (b === bit.remove) {
							this.meta.b.splice(idx, 1);
							if (vnodes[name]) {
								vnodes[name].elm.remove();
								delete vnodes[name];
							}
							return this.pub();
						}
						return box.get(name);
					}
					this.meta.b.push(name);
				} else {
					this.meta.b = [name];
				}
				this.pub();
				return this;
			};

			// bit.prototype.box = function(a, b) {
			// 	//if (!a) return this.meta.b;
			//
			// 	if (typeof a === 'function') {
			// 		const name = a.name || ('b' + (++__BIDX))
			// 		box.set(name, a)
			// 		a = name
			// 	}
			//
			// 	if (!b) b = document.body;
			//
			// 	if (!box.has(a))
			// 		throw new Error(a + ' box not found')
			//
			// 	if (this.meta.b) {
			// 		const idx = this.meta.b.indexOf(a)
			// 		if (idx > -1) {
			// 			if (b === bit.remove) {
			// 				this.meta.b.splice(idx, 1)
			// 				if (vnodes[a]) {
			// 					vnodes[a].elm.remove();
			// 					delete vnodes[a];
			// 				}
			// 				return this.pub()
			// 			}
			// 			return box.get(a)
			// 		}
			// 		this.meta.b.push(a)
			// 	} else {
			// 		this.meta.b = [a]
			// 	}
			// 	this.pub()
			// 	return this
			// }

			// bit.prototype.box = function(__box, __elm) {
			//     function sub(p, i) {
			//         try {
			//             box.render(__box(p, i), __elm)
			//         } catch(e) {
			// 			console.warn('bit!box', e)
			// 		}
			//         return sub
			//     }
			// 	if (this.meta.b)
			// 		this.meta.b.push(__box.name)
			// 	else
			// 		this.meta.b = [__box.name]
			// 	this.sub(sub(this))
			// 	return this
			// }

			bit.prototype.sub = function () {

				var f = arguments[0];
				var a = arguments[1] || null;
				var m = subscribers(this);

				if (!f) return m;

				if (typeof f === 'function') {
					var i = m.indexOf(f);

					if (i > -1) {
						var e = m.splice(i, 1);
						//console.log('[bit/sub/exists]', { name: f.name, index: i })
						if (a === bit.remove) {
							//console.log('[bit/sub/remove]', { name: f.name, index: i })
							return e;
						}
					}
					//console.log(`[bit/sub/push:${m.length}]`, f.name)
					return m.push(f);
				} else if (f === bit.remove) {
					//console.log('[bit/sub/clear]', this.meta, m)
					__submap['delete'](this);
					return m;
				}
			};Object.defineProperty(bit.prototype, 'toString', {
				value: function value() {
					return 'bit';
				}
			});
		}
	};
});
System.register('src/index', ['src/bit', 'src/box'], function (_export) {

    /** [bit!box] v0.1 [MIT] http://bitbox.pub
    	---------------------
    	Sergiu Toderascu (sergiu.toderascu@gmail.com)
    
        @module bitbox
        @constructor new bitbox([in: bit], [out: box])
        Create data-view instance
    	*/

    'use strict';

    var bit, box;
    return {
        setters: [function (_srcBit) {
            bit = _srcBit['default'];
        }, function (_srcBox) {
            box = _srcBox['default'];
        }],
        execute: function () {
            _export('bit', bit);

            _export('box', box);

            // Reflect.global.bitbox = bit(undefined, (b) => Reflect.global.bitbox = b)
            // setTimeout(() => Reflect.global.bitbox.box(function bitbox() {
            //     return new box('bitbox', {}, [
            //         box('h1', this.value || 'This is bitbox!'),
            //         box('code', JSON.stringify(this.meta))
            //     ])
            // }, document.body), 10)

            _export('default', function () {});

            /** wrapper function
                @arg [bit, box, elm]
                */

            // export default function bitbox() {
            //     const args = Array.prototype.slice.call(arguments)
            //     let app = bit(args.shift(), (b) => app = b).box(...args)
            //     return app
            // }

            Element.prototype.bitbox = function (a, b) {
                return a.box(b, this);
            };

            // bitbox.symbol = Symbol('[bit!box]')
            // bitbox.version = 0.1

            window.bit = bit;
            window.box = box;
            //Reflect.global.bitbox = bitbox

            /** ... */
        }
    };
});
System.register('chat/chat!box', ['src/index', 'repo/input!box', 'chat/message!box', 'chat/send!box'], function (_export) {
	'use strict';

	var bitbox, bit, box, style;

	_export('chat', chat);

	function chat(props) {
		var _this = this;

		return new box('chat', {
			key: 'chat-box'
		}, (function ($tree) {
			$tree.push(box.call(_this, 'section', {
				id: 'messages',
				style: style
			}, (function ($tree) {
				_this.messages.map(function (message) {
					$tree.push(box.call(message, 'message', {}));
				});
				return $tree;
			})([])));
			$tree.push(box.call(_this, 'send', {}));
			return $tree;
		})([]));
	}

	return {
		setters: [function (_srcIndex) {
			bitbox = _srcIndex['default'];
			bit = _srcIndex.bit;
			box = _srcIndex.box;
		}, function (_repoInputBox) {}, function (_chatMessageBox) {}, function (_chatSendBox) {}],
		execute: function () {
			box(chat);
			style = {
				display: 'block',
				position: 'fixed',
				height: window.innerHeight - 83,
				overflow: 'auto',
				left: 0,
				right: 0,
				top: 0
			};
		}
	};
});
System.register('chat/app', ['npm:babel-runtime@5.8.34/helpers/extends', 'npm:babel-runtime@5.8.34/helpers/to-consumable-array', 'chat/chat!box'], function (_export) {
	var _extends, _toConsumableArray, chat, id, wsc, store;

	function gotoBottom(id) {
		var element = document.getElementById(id);
		element.scrollTop = element.scrollHeight - element.clientHeight;
	}

	function sync(b) {
		_export('store', store = b);
	}

	function _in(b) {
		//console.log('_in', b)
	}

	function _out(b) {
		//console.log('_out', b)
		if (wsc.readyState === 1) {
			//if (store.out.value !== b.value)
			wsc.send(JSON.stringify(_extends({ type: 'out' }, b)));
		}
	}

	function _send(b) {
		//console.log('_send', b)
		if (wsc.readyState === 1) {
			//if (store.out.value !== b.value)
			wsc.send(JSON.stringify(_extends({ type: 'sent' }, b)));
		}
	}

	return {
		setters: [function (_npmBabelRuntime5834HelpersExtends) {
			_extends = _npmBabelRuntime5834HelpersExtends['default'];
		}, function (_npmBabelRuntime5834HelpersToConsumableArray) {
			_toConsumableArray = _npmBabelRuntime5834HelpersToConsumableArray['default'];
		}, function (_chatChatBox) {
			chat = _chatChatBox.chat;
		}],
		execute: function () {
			'use strict';

			id = Date.now();
			wsc = new WebSocket('ws://192.168.0.64:9393');

			wsc.onmessage = function (e) {
				var message = JSON.parse(e.data);
				//console.log('on-message', message)
				switch (message.type) {
					case 'out':
						if (message.id !== id) store['in'].pub(message);
						break;
					case 'sent':
						store.pub({ messages: [].concat(_toConsumableArray(store.messages), [message]) });
						gotoBottom('messages');
						break;
				}
			};store = {
				messages: [],
				'in': bit({ id: 0, value: '' }, _in),
				out: bit({ id: id, value: '' }, _out),
				send: bit({ id: id, value: '' }, _send)
			};

			_export('store', store);

			document.addEventListener('DOMContentLoaded', function () {
				return document.body.bitbox(bit(store, sync), chat);
			}, false);
		}
	};
});
});
//# sourceMappingURL=app-sfx.js.map
