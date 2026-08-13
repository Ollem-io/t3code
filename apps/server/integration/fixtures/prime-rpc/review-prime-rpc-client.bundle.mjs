#!/usr/bin/env node
import { copyFile as e, mkdtemp as t, rm as n } from "node:fs/promises";
import { tmpdir as r } from "node:os";
import { basename as i, join as a } from "node:path";
import { fileURLToPath as o } from "node:url";
import { spawn as s } from "node:child_process";
var c = class extends Error {
  _tag = `PrimeRpcFramingError`;
  reason;
  byteLength;
  constructor(e, t) {
    (super(`Prime Agent RPC framing failed: ${e}`), (this.reason = e), (this.byteLength = t));
  }
};
const l = (e, t) => {
  for (let n = t; n < e.length; n += 1) if (e[n] === 10) return n;
  return -1;
};
var u = class {
  #e;
  #t = [];
  #n = 0;
  #r = !1;
  constructor(e = {}) {
    if (((this.#e = e.maxRecordBytes ?? 1048576), !Number.isSafeInteger(this.#e) || this.#e < 1))
      throw RangeError(`maxRecordBytes must be a positive safe integer`);
  }
  push(e, t) {
    if (this.#r) throw Error(`Prime RPC JSONL parser is finished`);
    let n = 0;
    for (; n < e.length; ) {
      let r = l(e, n);
      if (r === -1) {
        this.#i(e.subarray(n));
        break;
      }
      this.#i(e.subarray(n, r));
      let i = this.#a();
      try {
        t(i);
      } catch (e) {
        throw (this.#s(), (this.#r = !0), e);
      }
      n = r + 1;
    }
  }
  finish() {
    if (!this.#r) {
      if (this.#n > 0) throw this.#o(`eof-fragment`, this.#n);
      this.#r = !0;
    }
  }
  #i(e) {
    if (e.length === 0) return;
    let t = this.#n + e.length;
    if (t > this.#e) throw this.#o(`record-too-large`, t);
    (this.#t.push(e.slice()), (this.#n = t));
  }
  #a() {
    let e = this.#n,
      t = new Uint8Array(e),
      n = 0;
    for (let e of this.#t) (t.set(e, n), (n += e.length));
    this.#s();
    let r = t.at(-1) === 13 ? t.subarray(0, -1) : t,
      i;
    try {
      i = new TextDecoder(`utf-8`, { fatal: !0 }).decode(r);
    } catch {
      throw this.#o(`invalid-utf8`, e);
    }
    try {
      return JSON.parse(i);
    } catch {
      throw this.#o(`invalid-json`, e);
    }
  }
  #o(e, t) {
    return (this.#s(), (this.#r = !0), new c(e, t));
  }
  #s() {
    ((this.#t = []), (this.#n = 0));
  }
};
const d = (e, t = {}) => {
    let n = t.maxRecordBytes ?? 1048576;
    if (!Number.isSafeInteger(n) || n < 1)
      throw RangeError(`maxRecordBytes must be a positive safe integer`);
    let r;
    try {
      r = JSON.stringify(e);
    } catch {
      throw new c(`writer-value`);
    }
    if (r === void 0) throw new c(`writer-value`);
    let i = new TextEncoder().encode(r);
    if (i.length > n) throw new c(`record-too-large`, i.length);
    let a = new Uint8Array(i.length + 1);
    return (a.set(i), (a[i.length] = 10), a);
  },
  f = (e, t) => {
    switch (t.length) {
      case 0:
        return e;
      case 1:
        return t[0](e);
      case 2:
        return t[1](t[0](e));
      case 3:
        return t[2](t[1](t[0](e)));
      case 4:
        return t[3](t[2](t[1](t[0](e))));
      case 5:
        return t[4](t[3](t[2](t[1](t[0](e)))));
      case 6:
        return t[5](t[4](t[3](t[2](t[1](t[0](e))))));
      case 7:
        return t[6](t[5](t[4](t[3](t[2](t[1](t[0](e)))))));
      case 8:
        return t[7](t[6](t[5](t[4](t[3](t[2](t[1](t[0](e))))))));
      case 9:
        return t[8](t[7](t[6](t[5](t[4](t[3](t[2](t[1](t[0](e)))))))));
      default: {
        let n = e;
        for (let e = 0, r = t.length; e < r; e++) n = t[e](n);
        return n;
      }
    }
  },
  p = {
    pipe() {
      return f(this, arguments);
    },
  },
  m = (function () {
    function e() {}
    return ((e.prototype = p), e);
  })(),
  h = function (e, t) {
    if (typeof e == `function`)
      return function () {
        return e(arguments) ? t.apply(this, arguments) : (e) => t(e, ...arguments);
      };
    switch (e) {
      case 0:
      case 1:
        throw RangeError(`Invalid arity ${e}`);
      case 2:
        return function (e, n) {
          return arguments.length >= 2
            ? t(e, n)
            : function (n) {
                return t(n, e);
              };
        };
      case 3:
        return function (e, n, r) {
          return arguments.length >= 3
            ? t(e, n, r)
            : function (r) {
                return t(r, e, n);
              };
        };
      default:
        return function () {
          if (arguments.length >= e) return t.apply(this, arguments);
          let n = arguments;
          return function (e) {
            return t(e, ...n);
          };
        };
    }
  },
  g = (e) => e,
  _ = (
    (e) => () =>
      e
  )(void 0),
  v = _;
function y(e) {
  let t = new WeakMap();
  return (n) => {
    if (t.has(n)) return t.get(n);
    let r = e(n);
    return (t.set(n, r), r);
  };
}
const ee = (e) => (t, n) => t === n || e(t, n),
  b = (e) => {
    let t = new Set(Reflect.ownKeys(e));
    if (e.constructor === Object) return t;
    e instanceof Error && t.delete(`stack`);
    let n = Object.getPrototypeOf(e),
      r = n;
    for (; r !== null && r !== Object.prototype; ) {
      let e = Reflect.ownKeys(r);
      for (let n = 0; n < e.length; n++) t.add(e[n]);
      r = Object.getPrototypeOf(r);
    }
    return (
      t.has(`constructor`) &&
        typeof e.constructor == `function` &&
        n === e.constructor.prototype &&
        t.delete(`constructor`),
      t
    );
  },
  te = new WeakSet();
function ne(e) {
  return typeof e == `string`;
}
function re(e) {
  return typeof e == `number`;
}
function ie(e) {
  return typeof e == `boolean`;
}
function ae(e) {
  return typeof e == `symbol`;
}
function oe(e) {
  return ne(e) || re(e) || ae(e);
}
function se(e) {
  return typeof e == `function`;
}
function ce(e) {
  return e != null;
}
function le(e) {
  return !0;
}
function ue(e) {
  return (typeof e == `object` && !!e) || se(e);
}
const x = h(2, (e, t) => ue(e) && t in e),
  S = `~effect/interfaces/Hash`,
  C = (e) => {
    switch (typeof e) {
      case `number`:
        return me(e);
      case `bigint`:
        return T(e.toString(10));
      case `boolean`:
        return T(String(e));
      case `symbol`:
        return T(String(e));
      case `string`:
        return T(e);
      case `undefined`:
        return T(`undefined`);
      case `function`:
      case `object`:
        if (e === null) return T(`null`);
        if (e instanceof Date)
          return Number.isNaN(e.getTime()) ? T(`Invalid Date`) : T(e.toISOString());
        if (e instanceof RegExp) return T(e.toString());
        {
          if (te.has(e)) return de(e);
          if (Se.has(e)) return Se.get(e);
          let t = we(e, () =>
            pe(e)
              ? e[S]()
              : typeof e == `function`
                ? de(e)
                : e instanceof DataView
                  ? ve(new Uint8Array(e.buffer, e.byteOffset, e.byteLength))
                  : Array.isArray(e) || ArrayBuffer.isView(e)
                    ? ve(e)
                    : e instanceof Map
                      ? ye(e)
                      : e instanceof Set
                        ? be(e)
                        : ge(e),
          );
          return (Se.set(e, t), t);
        }
      default:
        throw Error(
          `BUG: unhandled typeof ${typeof e} - please report an issue at https://github.com/Effect-TS/effect/issues`,
        );
    }
  },
  de = (e) => (xe.has(e) || xe.set(e, me(Math.floor(Math.random() * (2 ** 53 - 1)))), xe.get(e)),
  w = h(2, (e, t) => (e * 53) ^ t),
  fe = (e) => (e & 3221225471) | ((e >>> 1) & 1073741824),
  pe = (e) => x(e, S),
  me = (e) => {
    if (e !== e) return T(`NaN`);
    if (e === 1 / 0) return T(`Infinity`);
    if (e === -1 / 0) return T(`-Infinity`);
    let t = e | 0;
    for (t !== e && (t ^= e * 4294967295); e > 4294967295; ) t ^= e /= 4294967295;
    return fe(t);
  },
  T = (e) => {
    let t = 5381,
      n = e.length;
    for (; n; ) t = (t * 33) ^ e.charCodeAt(--n);
    return fe(t);
  },
  he = (e, t) => {
    let n = 12289;
    for (let r of t) n ^= w(C(r), C(e[r]));
    return fe(n);
  },
  ge = (e) => he(e, b(e)),
  _e = (e, t) => (n) => {
    let r = e;
    for (let e of n) r ^= t(e);
    return fe(r);
  },
  ve = _e(6151, C),
  ye = _e(T(`Map`), ([e, t]) => w(C(e), C(t))),
  be = _e(T(`Set`), C),
  xe = new WeakMap(),
  Se = new WeakMap(),
  Ce = new WeakSet();
function we(e, t) {
  if (Ce.has(e)) return T(`[Circular]`);
  Ce.add(e);
  let n = t();
  return (Ce.delete(e), n);
}
const E = `~effect/interfaces/Equal`;
function D() {
  return arguments.length === 1 ? (e) => Te(e, arguments[0]) : Te(arguments[0], arguments[1]);
}
function Te(e, t) {
  if (e === t) return !0;
  if (e == null || t == null) return !1;
  let n = typeof e;
  return n === typeof t
    ? n === `number` && e !== e && t !== t
      ? !0
      : (n !== `object` && n !== `function`) || te.has(e) || te.has(t)
        ? !1
        : Ae(e, t, ke)
    : !1;
}
function Ee(e, t, n) {
  let r = De.has(e),
    i = Oe.has(t);
  if (r && i) return !0;
  if (r || i) return !1;
  (De.add(e), Oe.add(t));
  let a = n();
  return (De.delete(e), Oe.delete(t), a);
}
const De = new WeakSet(),
  Oe = new WeakSet();
function ke(e, t) {
  if (C(e) !== C(t)) return !1;
  if (e instanceof Date) {
    if (!(t instanceof Date)) return !1;
    let n = e.getTime(),
      r = t.getTime();
    return n === r || (Number.isNaN(n) && Number.isNaN(r));
  } else if (e instanceof RegExp) return t instanceof RegExp ? e.toString() === t.toString() : !1;
  let n = ze(e),
    r = ze(t);
  if (n !== r) return !1;
  let i = n && r;
  return typeof e == `function` && !i
    ? !1
    : Ee(e, t, () => {
        if (i) return e[E](t);
        if (Array.isArray(e)) return !Array.isArray(t) || e.length !== t.length ? !1 : Me(e, t);
        if (ArrayBuffer.isView(e)) {
          let n = e instanceof DataView;
          if (
            !ArrayBuffer.isView(t) ||
            e.byteLength !== t.byteLength ||
            n !== t instanceof DataView
          )
            return !1;
          if (n) {
            let n = t;
            return Ne(
              new Uint8Array(e.buffer, e.byteOffset, e.byteLength),
              new Uint8Array(n.buffer, n.byteOffset, n.byteLength),
            );
          }
          return Ne(e, t);
        } else if (e instanceof Map)
          return !(t instanceof Map) || e.size !== t.size ? !1 : Ie(e, t);
        else if (e instanceof Set) return !(t instanceof Set) || e.size !== t.size ? !1 : Re(e, t);
        return Pe(e, t);
      });
}
function Ae(e, t, n) {
  let r = je.get(e);
  if (!r) ((r = new WeakMap()), je.set(e, r));
  else if (r.has(t)) return r.get(t);
  let i = n(e, t);
  r.set(t, i);
  let a = je.get(t);
  return (a || ((a = new WeakMap()), je.set(t, a)), a.set(e, i), i);
}
const je = new WeakMap();
function Me(e, t) {
  for (let n = 0; n < e.length; n++) if (!Te(e[n], t[n])) return !1;
  return !0;
}
function Ne(e, t) {
  if (e.length !== t.length) return !1;
  for (let n = 0; n < e.length; n++) if (e[n] !== t[n]) return !1;
  return !0;
}
function Pe(e, t) {
  let n = b(e),
    r = b(t);
  if (n.size !== r.size) return !1;
  for (let i of n) if (!r.has(i) || !Te(e[i], t[i])) return !1;
  return !0;
}
function Fe(e, t) {
  return function (n, r) {
    for (let [i, a] of n) {
      let n = !1;
      for (let [o, s] of r)
        if (e(i, o) && t(a, s)) {
          n = !0;
          break;
        }
      if (!n) return !1;
    }
    return !0;
  };
}
const Ie = Fe(Te, Te);
function Le(e) {
  return function (t, n) {
    for (let r of t) {
      let t = !1;
      for (let i of n)
        if (e(r, i)) {
          t = !0;
          break;
        }
      if (!t) return !1;
    }
    return !0;
  };
}
const Re = Le(Te),
  ze = (e) => x(e, E),
  Be = Symbol.for(`~effect/Redactable`),
  Ve = (e) => x(e, Be);
function He(e) {
  return Ve(e) ? Ue(e) : e;
}
function Ue(e) {
  return e[Be](globalThis[`~effect/Fiber/currentFiber`]?.context ?? Ke);
}
const We = `~effect/Fiber/currentFiber`,
  Ge = new Map(),
  Ke = {
    "~effect/Context": {},
    base: Ge,
    depth: 0,
    mapUnsafe: Ge,
    pipe() {
      return f(this, arguments);
    },
  };
function O(e, t) {
  let n = t?.space ?? 0,
    r = new WeakSet(),
    i = n ? (typeof n == `number` ? ` `.repeat(n) : n) : ``,
    a = (e) => i.repeat(e),
    o = (e, t) => {
      let n = e?.constructor;
      return n && n !== Object.prototype.constructor && n.name ? `${n.name}(${t})` : t;
    },
    s = (e) => {
      try {
        return Reflect.ownKeys(e);
      } catch {
        return [`[ownKeys threw]`];
      }
    };
  function c(e, n = 0) {
    if (Array.isArray(e)) {
      if (r.has(e)) return qe;
      r.add(e);
      let t =
        !i || e.length <= 1
          ? `[${e.map((e) => c(e, n)).join(`,`)}]`
          : `[\n${a(n + 1)}${e
              .map((e) => c(e, n + 1))
              .join(
                `,
` + a(n + 1),
              )}\n${a(n)}]`;
      return (r.delete(e), t);
    }
    if (e instanceof Date) return Xe(e);
    if (
      !t?.ignoreToString &&
      x(e, `toString`) &&
      typeof e.toString == `function` &&
      e.toString !== Object.prototype.toString &&
      e.toString !== Array.prototype.toString
    ) {
      let t = Ze(e);
      return e instanceof Error && e.cause ? `${t} (cause: ${c(e.cause, n)})` : t;
    }
    if (typeof e == `string`) return JSON.stringify(e);
    if (typeof e == `number` || e == null || typeof e == `boolean` || typeof e == `symbol`)
      return String(e);
    if (typeof e == `bigint`) return String(e) + `n`;
    if (typeof e == `object` || typeof e == `function`) {
      if (r.has(e)) return qe;
      r.add(e);
      let t;
      if (Be in e) t = O(Ue(e));
      else if (Symbol.iterator in e) t = `${e.constructor.name}(${c(Array.from(e), n)})`;
      else {
        let r = s(e);
        if (!i || r.length <= 1) {
          let i = `{${r.map((t) => `${Je(t)}:${c(e[t], n)}`).join(`,`)}}`;
          t = o(e, i);
        } else {
          let i = `{\n${r.map((t) => `${a(n + 1)}${Je(t)}: ${c(e[t], n + 1)}`).join(`,
`)}\n${a(n)}}`;
          t = o(e, i);
        }
      }
      return (r.delete(e), t);
    }
    return String(e);
  }
  return c(e, 0);
}
const qe = `[Circular]`;
function Je(e) {
  return typeof e == `string` ? JSON.stringify(e) : String(e);
}
function Ye(e) {
  return e.map((e) => `[${Je(e)}]`).join(``);
}
function Xe(e) {
  try {
    return e.toISOString();
  } catch {
    return `Invalid Date`;
  }
}
function Ze(e) {
  try {
    let t = e.toString();
    return typeof t == `string` ? t : String(t);
  } catch {
    return `[toString threw]`;
  }
}
const Qe = Symbol.for(`nodejs.util.inspect.custom`),
  $e = (e) => {
    try {
      if (x(e, `toJSON`) && se(e.toJSON) && e.toJSON.length === 0) return e.toJSON();
      if (Array.isArray(e)) return e.map($e);
    } catch {
      return `[toJSON threw]`;
    }
    return He(e);
  };
var et = class e {
  called = !1;
  self;
  constructor(e) {
    this.self = e;
  }
  next(e) {
    return this.called
      ? { value: e, done: !0 }
      : ((this.called = !0), { value: this.self, done: !1 });
  }
  [Symbol.iterator]() {
    return new e(this.self);
  }
};
const tt = (() => {
  let e = `~effect/Utils/internal`,
    t = { [e]: (e) => e() },
    n = {
      [e]: (e) => {
        try {
          return e();
        } finally {
        }
      },
    };
  return t[e](() => Error().stack)?.includes(e) === !0 ? t[e] : n[e];
})();
function nt(e, t, n) {
  t === `__proto__`
    ? Object.defineProperty(e, t, { value: n, writable: !0, enumerable: !0, configurable: !0 })
    : (e[t] = n);
}
function rt(e, t) {
  for (let n of Reflect.ownKeys(t))
    Object.prototype.propertyIsEnumerable.call(t, n) && nt(e, n, t[n]);
}
const it = `~effect/Effect`,
  at = `~effect/Exit`,
  ot = { _A: g, _E: g, _R: g },
  st = `${it}/identifier`,
  k = `${it}/args`,
  A = `${it}/evaluate`,
  j = `${it}/successCont`,
  M = `${it}/failureCont`,
  ct = `${it}/ensureCont`,
  lt = Symbol.for(`effect/Effect/Yield`),
  ut = {
    pipe() {
      return f(this, arguments);
    },
    toJSON() {
      return { ...this };
    },
    toString() {
      return O(this.toJSON(), { ignoreToString: !0, space: 2 });
    },
    [Qe]() {
      return this.toJSON();
    },
  },
  dt = {
    [it]: ot,
    ...ut,
    [Symbol.iterator]() {
      return new et(this);
    },
    toJSON() {
      return { _id: `Effect`, op: this[st], ...(k in this ? { args: this[k] } : void 0) };
    },
  },
  ft = (e) => x(e, at),
  pt = `~effect/Cause`,
  mt = `~effect/Cause/Reason`,
  ht = (e) => x(e, pt);
var gt = class {
  [pt];
  reasons;
  constructor(e) {
    ((this[pt] = pt), (this.reasons = e));
  }
  pipe() {
    return f(this, arguments);
  }
  toJSON() {
    return { _id: `Cause`, failures: this.reasons.map((e) => e.toJSON()) };
  }
  toString() {
    return `Cause(${O(this.reasons)})`;
  }
  [Qe]() {
    return this.toJSON();
  }
  [E](e) {
    return (
      ht(e) &&
      this.reasons.length === e.reasons.length &&
      this.reasons.every((t, n) => D(t, e.reasons[n]))
    );
  }
  [S]() {
    return ve(this.reasons);
  }
};
const _t = new WeakMap();
var vt = class {
  [mt];
  annotations;
  _tag;
  constructor(e, t, n) {
    if (((this[mt] = mt), (this._tag = e), t !== yt && typeof n == `object` && n && t.size > 0)) {
      let e = _t.get(n);
      (e && (t = new Map([...e, ...t])), _t.set(n, t));
    }
    this.annotations = t;
  }
  annotate(e, t) {
    if (e.mapUnsafe.size === 0) return this;
    let n = new Map(this.annotations);
    e.mapUnsafe.forEach((e, r) => {
      (t?.overwrite !== !0 && n.has(r)) || n.set(r, e);
    });
    let r = Object.assign(Object.create(Object.getPrototypeOf(this)), this);
    return ((r.annotations = n), r);
  }
  pipe() {
    return f(this, arguments);
  }
  toString() {
    return O(this);
  }
  [Qe]() {
    return this.toString();
  }
};
const yt = new Map();
var bt = class extends vt {
  error;
  constructor(e, t = yt) {
    (super(`Fail`, t, e), (this.error = e));
  }
  toString() {
    return `Fail(${O(this.error)})`;
  }
  toJSON() {
    return { _tag: `Fail`, error: this.error };
  }
  [E](e) {
    return Et(e) && D(this.error, e.error) && D(this.annotations, e.annotations);
  }
  [S]() {
    return w(T(this._tag))(w(C(this.error))(C(this.annotations)));
  }
};
const xt = (e) => new gt(e),
  St = (e) => new gt([new bt(e)]);
var Ct = class extends vt {
  defect;
  constructor(e, t = yt) {
    (super(`Die`, t, e), (this.defect = e));
  }
  toString() {
    return `Die(${O(this.defect)})`;
  }
  toJSON() {
    return { _tag: `Die`, defect: this.defect };
  }
  [E](e) {
    return Dt(e) && D(this.defect, e.defect) && D(this.annotations, e.annotations);
  }
  [S]() {
    return w(T(this._tag))(w(C(this.defect))(C(this.annotations)));
  }
};
const wt = (e) => new gt([new Ct(e)]),
  Tt = h(
    (e) => ht(e[0]),
    (e, t, n) => (t.mapUnsafe.size === 0 ? e : new gt(e.reasons.map((e) => e.annotate(t, n)))),
  ),
  Et = (e) => e._tag === `Fail`,
  Dt = (e) => e._tag === `Die`,
  Ot = (e) => e._tag === `Interrupt`;
function kt(e) {
  return Rt(`Effect.evaluate: Not implemented`);
}
const At = (e) => ({ ...dt, [st]: e.op, [A]: e[A] ?? kt, [j]: e[j], [M]: e[M], [ct]: e[ct] }),
  jt = (e) => {
    let t = At(e);
    return function () {
      let n = Object.create(t);
      return ((n[k] = e.single === !1 ? arguments : arguments[0]), n);
    };
  },
  Mt = (e) => {
    let t = {
      [at]: at,
      _tag: e.op,
      get [e.prop]() {
        return this[k];
      },
      ...At(e),
      toString() {
        return `${e.op}(${O(this[k])})`;
      },
      toJSON() {
        return { _id: `Exit`, _tag: e.op, [e.prop]: this[k] };
      },
      [E](e) {
        return ft(e) && e._tag === this._tag && D(this[k], e[k]);
      },
      [S]() {
        return w(T(e.op), C(this[k]));
      },
    };
    return function (e) {
      let n = Object.create(t);
      return ((n[k] = e), n);
    };
  },
  Nt = Mt({
    op: `Success`,
    prop: `value`,
    [A](e) {
      let t = e.getCont(j);
      return t ? t[j](this[k], e, this) : e.yieldWith(this);
    },
  }),
  Pt = { key: `effect/Cause/StackTrace` },
  Ft = { key: `effect/Cause/InterruptorStackTrace` },
  It = Mt({
    op: `Failure`,
    prop: `cause`,
    [A](e) {
      let t = this[k],
        n = !1;
      e.currentStackFrame &&
        ((t = Tt(t, { mapUnsafe: new Map([[Pt.key, e.currentStackFrame]]) })), (n = !0));
      let r = e.getCont(M);
      for (; e.interruptible && e._interruptedCause && r; ) r = e.getCont(M);
      return r ? r[M](t, e, n ? void 0 : this) : e.yieldWith(n ? It(t) : this);
    },
  }),
  Lt = (e) => It(St(e)),
  Rt = (e) => It(wt(e)),
  zt = jt({
    op: `WithFiber`,
    [A](e) {
      return this[k](e);
    },
  }),
  Bt = (function () {
    class e extends globalThis.Error {}
    let t = At({
      op: `YieldableError`,
      [A]() {
        return Lt(this);
      },
    });
    return (delete t.toString, Object.assign(e.prototype, t), e);
  })(),
  Vt = (function () {
    let e = Symbol.for(`effect/Data/Error/plainArgs`);
    return class extends Bt {
      constructor(t) {
        (super(t?.message, t?.cause ? { cause: t.cause } : void 0),
          t && (rt(this, t), Object.defineProperty(this, e, { value: t, enumerable: !1 })));
      }
      toJSON() {
        return { ...this[e], ...this };
      }
    };
  })(),
  Ht = (e) => {
    class t extends Vt {
      _tag = e;
    }
    return ((t.prototype.name = e), t);
  };
Ht(`NoSuchElementError`);
const Ut = `~effect/data/Option`,
  Wt = {
    [Ut]: { _A: (e) => e },
    ...ut,
    [Symbol.iterator]() {
      return new et(this);
    },
  },
  Gt = Object.defineProperty(
    Object.assign(Object.create(Wt), {
      _tag: `Some`,
      _op: `Some`,
      [E](e) {
        return Jt(e) && Xt(e) && D(this.value, e.value);
      },
      [S]() {
        return w(C(this._tag))(C(this.value));
      },
      toString() {
        return `some(${O(this.value)})`;
      },
      toJSON() {
        return { _id: `Option`, _tag: this._tag, value: $e(this.value) };
      },
    }),
    "valueOrUndefined",
    {
      get() {
        return this.value;
      },
    },
  ),
  Kt = C(`None`),
  qt = Object.assign(Object.create(Wt), {
    _tag: `None`,
    _op: `None`,
    valueOrUndefined: void 0,
    [E](e) {
      return Jt(e) && Yt(e);
    },
    [S]() {
      return Kt;
    },
    toString() {
      return `none()`;
    },
    toJSON() {
      return { _id: `Option`, _tag: this._tag };
    },
  }),
  Jt = (e) => x(e, Ut),
  Yt = (e) => e._tag === `None`,
  Xt = (e) => e._tag === `Some`,
  Zt = Object.create(qt),
  Qt = (e) => {
    let t = Object.create(Gt);
    return ((t.value = e), t);
  },
  $t = `~effect/data/Result`,
  en = {
    [$t]: { _A: (e) => e, _E: (e) => e },
    ...ut,
    [Symbol.iterator]() {
      return new et(this);
    },
  },
  tn = Object.assign(Object.create(en), {
    _tag: `Success`,
    _op: `Success`,
    [E](e) {
      return rn(e) && on(e) && D(this.success, e.success);
    },
    [S]() {
      return w(C(this._tag))(C(this.success));
    },
    toString() {
      return `success(${O(this.success)})`;
    },
    toJSON() {
      return { _id: `Result`, _tag: this._tag, value: $e(this.success) };
    },
  }),
  nn = Object.assign(Object.create(en), {
    _tag: `Failure`,
    _op: `Failure`,
    [E](e) {
      return rn(e) && an(e) && D(this.failure, e.failure);
    },
    [S]() {
      return w(C(this._tag))(C(this.failure));
    },
    toString() {
      return `failure(${O(this.failure)})`;
    },
    toJSON() {
      return { _id: `Result`, _tag: this._tag, failure: $e(this.failure) };
    },
  }),
  rn = (e) => x(e, $t),
  an = (e) => e._tag === `Failure`,
  on = (e) => e._tag === `Success`,
  sn = (e) => {
    let t = Object.create(nn);
    return ((t.failure = e), t);
  },
  cn = (e) => {
    let t = Object.create(tn);
    return ((t.success = e), t);
  },
  ln = sn,
  un = an,
  dn = on,
  fn = h(2, (e, t) => (un(e) ? ln(t(e.failure)) : e)),
  pn = (e) => e.length > 0,
  mn = () => Zt,
  hn = Qt,
  gn = Yt,
  _n = h(2, (e, t) => (gn(e) ? mn() : hn(t(e.value)))),
  vn = globalThis.Array,
  yn = (e) => (vn.isArray(e) ? e : vn.from(e)),
  bn = h(2, (e, t) => [...e, t]),
  xn = h(2, (e, t) => yn(e).concat(yn(t)));
vn.isArray;
const Sn = pn,
  Cn = pn,
  wn = (e, t) => {
    let n = C(t),
      r = e.get(n);
    if (r === void 0) return (e.set(n, [t]), !0);
    for (let e of r) if (D(e, t)) return !1;
    return (r.push(t), !0);
  },
  Tn = h(2, (e, t) => {
    let n = yn(e),
      r = yn(t);
    return Cn(n) ? (Cn(r) ? On(xn(n, r)) : n) : r;
  }),
  En = () => [],
  Dn = h(2, (e, t) => e.map(t)),
  On = (e) => {
    let t = yn(e);
    if (t.length < 2) return [...t];
    let n = new Map(),
      r = [];
    for (let e of t) wn(n, e) && r.push(e);
    return r;
  },
  kn = `~effect/BigDecimal`,
  An = {
    [kn]: kn,
    [S]() {
      let e = Ln(this);
      return w(C(e.value), me(e.scale));
    },
    [E](e) {
      return jn(e) && Vn(this, e);
    },
    toString() {
      return `BigDecimal(${Hn(this)})`;
    },
    toJSON() {
      return { _id: `BigDecimal`, value: String(this.value), scale: this.scale };
    },
    [Qe]() {
      return this.toJSON();
    },
    pipe() {
      return f(this, arguments);
    },
  },
  jn = (e) => x(e, kn),
  Mn = (e, t) => {
    let n = Object.create(An);
    return ((n.value = e), (n.scale = t), n);
  },
  Nn = (e, t) => {
    if (e !== Pn && e % Fn === Pn) throw RangeError(`Value must be normalized`);
    let n = Mn(e, t);
    return ((n.normalized = n), n);
  },
  Pn = BigInt(0),
  Fn = BigInt(10),
  In = Nn(Pn, 0),
  Ln = (e) => {
    if (e.normalized === void 0)
      if (e.value === Pn) e.normalized = In;
      else {
        let t = `${e.value}`,
          n = 0;
        for (let e = t.length - 1; e >= 0 && t[e] === `0`; e--) n++;
        n === 0 && (e.normalized = e);
        let r = BigInt(t.substring(0, t.length - n)),
          i = e.scale - n;
        e.normalized = Nn(r, i);
      }
    return e.normalized;
  },
  Rn = h(2, (e, t) =>
    t > e.scale
      ? Mn(e.value * Fn ** BigInt(t - e.scale), t)
      : t < e.scale
        ? Mn(e.value / Fn ** BigInt(e.scale - t), t)
        : e,
  ),
  zn = (e) => (e.value < Pn ? Mn(-e.value, e.scale) : e),
  Bn = ee((e, t) =>
    e.scale > t.scale
      ? Rn(t, e.scale).value === e.value
      : e.scale < t.scale
        ? Rn(e, t.scale).value === t.value
        : e.value === t.value,
  ),
  Vn = h(2, (e, t) => Bn(e, t)),
  Hn = (e) => {
    let t = Ln(e);
    if (Math.abs(t.scale) >= 16) return Un(t);
    let n = t.value < Pn,
      r = n ? `${t.value}`.substring(1) : `${t.value}`,
      i,
      a;
    if (t.scale >= r.length) ((i = `0`), (a = `0`.repeat(t.scale - r.length) + r));
    else {
      let e = r.length - t.scale;
      if (e > r.length) {
        let t = e - r.length;
        ((i = `${r}${`0`.repeat(t)}`), (a = ``));
      } else ((a = r.slice(e)), (i = r.slice(0, e)));
    }
    let o = a === `` ? i : `${i}.${a}`;
    return n ? `-${o}` : o;
  },
  Un = (e) => {
    if (Wn(e)) return `0e+0`;
    let t = Ln(e),
      n = `${zn(t).value}`,
      r = n.slice(0, 1),
      i = n.slice(1),
      a = `${Gn(t) ? `-` : ``}${r}`;
    i !== `` && (a += `.${i}`);
    let o = i.length - t.scale;
    return `${a}e${o >= 0 ? `+` : ``}${o}`;
  },
  Wn = (e) => e.value === Pn,
  Gn = (e) => e.value < Pn,
  Kn = (e) => At({ op: e.label, [A]: e.evaluate }),
  qn = (() => {
    let e = Object.getOwnPropertyDescriptor(Error, `stackTraceLimit`);
    return e === void 0
      ? Object.isExtensible(Error)
      : Object.hasOwn(e, `writable`)
        ? e.writable === !0
        : e.set !== void 0;
  })(),
  Jn = () => Error.stackTraceLimit,
  Yn = (e) => {
    qn && (Error.stackTraceLimit = e);
  },
  Xn = `~effect/Context/Service`,
  Zn = function () {
    let e = Jn();
    Yn(2);
    let t = Error();
    Yn(e);
    function n() {}
    let r = n;
    (Object.setPrototypeOf(r, Qn),
      Object.defineProperty(r, "stack", {
        get() {
          return t.stack;
        },
      }));
    let i = (e, t) => (
      (r.key = e),
      t?.defaultValue && ((r[er] = er), (r.defaultValue = t.defaultValue)),
      t?.make && (r.make = t.make),
      t?.fiberCached && $n.add(e),
      r
    );
    return arguments.length > 0 ? i(arguments[0], arguments[1]) : i;
  },
  Qn = {
    [Xn]: Xn,
    ...Kn({
      label: `Service`,
      evaluate(e) {
        return Nt(_r(e.context, this));
      },
    }),
    toJSON() {
      return { _id: `Service`, key: this.key, stack: this.stack };
    },
    of(e) {
      return e;
    },
    context(e) {
      return mr(this, e);
    },
    use(e) {
      return zt((t) => e(_r(t.context, this)));
    },
    useSync(e) {
      return zt((t) => Nt(e(_r(t.context, this))));
    },
  },
  $n = new Set(),
  er = `~effect/Context/Reference`,
  tr = `~effect/Context`,
  nr = (e, t, n, r) => {
    let i = Object.create(cr);
    return (
      (i.cacheRoot = e ?? i),
      (i.base = t),
      (i.overlay = n),
      (i.depth = r),
      (i._flat = void 0),
      (i.baseHits = 0),
      i
    );
  },
  rr = (e, t) => {
    t && (rr(e, t.parent), e.set(t.key, t.value));
  },
  ir = (e) => {
    if (e._flat) return e._flat;
    if (!e.overlay) return (e._flat = e.base);
    let t = new Map(e.base);
    return (rr(t, e.overlay), (e._flat = t));
  },
  ar = Symbol(),
  or = (e, t) => {
    let n = e;
    for (let e = n.overlay; e; e = e.parent) if (e.key === t) return e.value;
    let r = n.base.get(t);
    return r === void 0 && !n.base.has(t)
      ? ar
      : (n.overlay && ++n.baseHits >= 8 && ((n.base = ir(n)), (n.overlay = void 0), (n.depth = 0)),
        r);
  },
  sr = (e) => nr(void 0, e, void 0, 0),
  cr = {
    ...ut,
    [tr]: { _Services: (e) => e },
    get mapUnsafe() {
      return ir(this);
    },
    toJSON() {
      return {
        _id: `Context`,
        services: Array.from(this.mapUnsafe).map(([e, t]) => ({ key: e, value: t })),
      };
    },
    [E](e) {
      if (!ur(e)) return !1;
      let t = this.mapUnsafe,
        n = e.mapUnsafe;
      if (t.size !== n.size) return !1;
      for (let [e, r] of t) if (!n.has(e) || !D(r, n.get(e))) return !1;
      return !0;
    },
    [S]() {
      return me(this.mapUnsafe.size);
    },
  },
  lr = (e, t) => e.cacheRoot === t.cacheRoot,
  ur = (e) => x(e, tr),
  dr = (e) => !!e[er],
  fr = () => pr,
  pr = sr(new Map()),
  mr = (e, t) => sr(new Map([[e.key, t]])),
  hr = h(3, (e, t, n) => {
    let r = e,
      i = $n.has(t.key) ? void 0 : r.cacheRoot;
    if (r.depth >= 8) {
      let e = new Map(r.mapUnsafe);
      return (e.set(t.key, n), nr(i, e, void 0, 0));
    }
    return nr(i, r.base, { key: t.key, value: n, parent: r.overlay }, r.depth + 1);
  }),
  gr = (e, t) => {
    let n = or(e, t);
    return n === ar ? void 0 : n;
  },
  _r = h(2, (e, t) => {
    let n = or(e, t.key);
    if (n === ar) {
      if (dr(t)) return yr(t);
      throw br(t);
    }
    return n;
  }),
  vr = `~effect/Context/defaultValue`,
  yr = (e) => (vr in e ? e[vr] : (e[vr] = e.defaultValue())),
  br = (e) => {
    let t = Error(`Service not found${e.key ? `: ${String(e.key)}` : ``}`);
    if (e.stack) {
      let n = e.stack.split(`
`);
      if (n.length > 2) {
        let e = n[2].match(/at (.*)/);
        e && (t.message += ` (defined at ${e[1]})`);
      }
    }
    if (t.stack) {
      let e = t.stack.split(`
`);
      (e.splice(1, 3),
        (t.stack = e.join(`
`)));
    }
    return t;
  },
  xr = Zn,
  Sr = xr(`effect/Scheduler`, { fiberCached: !0, defaultValue: () => new Er() }),
  Cr =
    `setImmediate` in globalThis
      ? (e) => {
          let t = globalThis.setImmediate(e);
          return () => globalThis.clearImmediate(t);
        }
      : (e) => {
          let t = setTimeout(e, 0);
          return () => clearTimeout(t);
        },
  wr = (e) => {
    let t = !1;
    return (
      queueMicrotask(() => {
        t || e();
      }),
      () => {
        t = !0;
      }
    );
  };
var Tr = class {
    buckets = [];
    scheduleTask(e, t) {
      let n = this.buckets,
        r = n.length,
        i,
        a = 0;
      for (; a < r && !(n[a][0] > t); a++) i = n[a];
      i && i[0] === t ? i[1].push(e) : a === r ? n.push([t, [e]]) : n.splice(a, 0, [t, [e]]);
    }
    drain() {
      let e = this.buckets;
      return ((this.buckets = []), e);
    }
  },
  Er = class {
    executionMode;
    setImmediate;
    constructor(e = `async`, t) {
      ((this.executionMode = e), (this.setImmediate = t ?? (e === `sync` ? wr : Cr)));
    }
    shouldYield(e) {
      return e.currentOpCount >= e.maxOpsBeforeYield;
    }
    makeDispatcher() {
      return new Dr(this.setImmediate);
    }
  },
  Dr = class {
    tasks = new Tr();
    running = void 0;
    setImmediate;
    constructor(e = Cr) {
      this.setImmediate = e;
    }
    scheduleTask(e, t) {
      (this.tasks.scheduleTask(e, t),
        this.running === void 0 && (this.running = this.setImmediate(this.afterScheduled)));
    }
    afterScheduled = () => {
      ((this.running = void 0), this.runTasks());
    };
    runTasks() {
      let e = this.tasks.drain();
      for (let t = 0; t < e.length; t++) {
        let n = e[t][1];
        for (let e = 0; e < n.length; e++) n[e]();
      }
    }
    flush() {
      for (; this.tasks.buckets.length > 0; )
        (this.running !== void 0 && (this.running(), (this.running = void 0)), this.runTasks());
    }
  };
const Or = xr(`effect/Scheduler/MaxOpsBeforeYield`, { fiberCached: !0, defaultValue: () => 2048 }),
  kr = xr(`effect/Scheduler/PreventSchedulerYield`, { fiberCached: !0, defaultValue: () => !1 }),
  Ar = `effect/Tracer/ParentSpan`;
Zn()(Ar, { fiberCached: !0 });
const jr = xr(`effect/References/CurrentStackFrame`, { fiberCached: !0, defaultValue: _ }),
  Mr = xr(`effect/References/CurrentLogLevel`, { fiberCached: !0, defaultValue: () => `Info` }),
  Nr = xr(`effect/References/MinimumLogLevel`, { fiberCached: !0, defaultValue: () => `Info` });
var Pr = class extends vt {
  fiberId;
  constructor(e, t = yt) {
    (super(`Interrupt`, t, `Interrupted`), (this.fiberId = e));
  }
  toString() {
    return `Interrupt(${this.fiberId})`;
  }
  toJSON() {
    return { _tag: `Interrupt`, fiberId: this.fiberId };
  }
  [E](e) {
    return Ot(e) && this.fiberId === e.fiberId && this.annotations === e.annotations;
  }
  [S]() {
    return w(T(`${this._tag}:${this.fiberId}`))(de(this.annotations));
  }
};
const Fr = (e) => new gt([new Pr(e)]),
  Ir = (e) => e.reasons.some(Ot),
  Lr = h(2, (e, t) => {
    if (e.reasons.length === 0) return t;
    if (t.reasons.length === 0) return e;
    let n = new gt(Tn(e.reasons, t.reasons));
    return D(e, n) ? e : n;
  }),
  Rr = h(2, (e, t) => {
    let n = !1,
      r = e.reasons.map((e) => (Et(e) ? ((n = !0), new bt(t(e.error), e.annotations)) : e));
    return n ? xt(r) : e;
  }),
  zr = `~effect/Fiber`,
  Br = { _A: g, _E: g },
  Vr = { id: 0 },
  Hr = () => globalThis[We];
var Ur = class {
  constructor(e, t = !0) {
    ((this[zr] = Br),
      this.setContext(e),
      (this.id = ++Vr.id),
      (this.currentOpCount = 0),
      (this.interruptible = t),
      (this._stack = []),
      (this._observers = []),
      (this._exit = void 0),
      (this._children = void 0),
      (this._interruptedCause = void 0),
      (this._yielded = void 0),
      (this._running = !1),
      (this._deferredInterrupt = !1),
      this.runtimeMetrics?.recordFiberStart(this.context));
  }
  [zr];
  id;
  interruptible;
  currentOpCount;
  _stack;
  _observers;
  _exit;
  _children;
  _interruptedCause;
  _yielded;
  _running;
  _deferredInterrupt;
  context;
  currentScheduler;
  currentTracerContext;
  currentSpan;
  currentLogLevel;
  minimumLogLevel;
  currentStackFrame;
  runtimeMetrics;
  maxOpsBeforeYield;
  currentPreventYield;
  _dispatcher = void 0;
  get currentDispatcher() {
    return (this._dispatcher ??= this.currentScheduler.makeDispatcher());
  }
  getRef(e) {
    return _r(this.context, e);
  }
  addObserver(e) {
    return this._exit
      ? (e(this._exit), v)
      : (this._observers.push(e),
        () => {
          let t = this._observers.indexOf(e);
          t >= 0 && this._observers.splice(t, 1);
        });
  }
  interruptUnsafe(e, t) {
    if (this._exit) return;
    let n = Fr(e);
    (this.currentStackFrame && (n = Tt(n, mr(Pt, this.currentStackFrame))),
      t && (n = Tt(n, t)),
      (this._interruptedCause = this._interruptedCause ? Lr(this._interruptedCause, n) : n),
      this.interruptible &&
        (this._running
          ? (this._deferredInterrupt = !0)
          : this.evaluate(Xr(this._interruptedCause))));
  }
  pollUnsafe() {
    return this._exit;
  }
  evaluate(e) {
    if (this._exit) return;
    if (this._yielded !== void 0) {
      let e = this._yielded;
      ((this._yielded = void 0), e());
    }
    let t = this.runLoop(e);
    if (t === lt) return;
    let n = Gr.interruptChildren && Gr.interruptChildren(this);
    if (n !== void 0) return this.evaluate(N(n, () => t));
    ((this._exit = t), this.runtimeMetrics?.recordFiberEnd(this.context, this._exit));
    for (let e = 0; e < this._observers.length; e++) this._observers[e](t);
    ((this._observers.length = 0),
      (this._stack.length = 0),
      (this._children = void 0),
      (this.context = fr()));
  }
  runLoop(e) {
    let t = globalThis[We];
    globalThis[We] = this;
    let n = this._running;
    this._running = !0;
    let r = !1,
      i = e;
    this.currentOpCount = 0;
    try {
      for (;;) {
        if (
          (this._deferredInterrupt &&
            ((this._deferredInterrupt = !1), (i = Xr(this._interruptedCause))),
          this.currentOpCount++,
          !r && !this.currentPreventYield && this.currentScheduler.shouldYield(this))
        ) {
          r = !0;
          let e = i;
          i = N(ei, () => e);
        }
        if (
          ((i = this.currentTracerContext ? this.currentTracerContext(i, this) : i[A](this)),
          i === lt)
        ) {
          let e = this._yielded;
          if (at in e) return ((this._deferredInterrupt = !1), (this._yielded = void 0), e);
          if (this._deferredInterrupt) {
            ((this._yielded = void 0), e());
            continue;
          }
          return lt;
        }
      }
    } catch (e) {
      return x(i, A) ? this.runLoop(Rt(e)) : Rt(`Fiber.runLoop: Not a valid effect: ${String(i)}`);
    } finally {
      ((this._running = n), (globalThis[We] = t));
    }
  }
  getCont(e) {
    if (this._deferredInterrupt) return ((this._deferredInterrupt = !1), Wr);
    for (;;) {
      let t = this._stack.pop();
      if (!t) return;
      let n = t[ct] && t[ct](this);
      if (n) return ((n[e] = n), n);
      if (t[e]) return t;
    }
  }
  yieldWith(e) {
    return ((this._yielded = e), lt);
  }
  children() {
    return (this._children ??= new Set());
  }
  pipe() {
    return f(this, arguments);
  }
  setContext(e) {
    let t = this.context;
    if (((this.context = e), t !== void 0 && lr(t, e))) return;
    let n = this.getRef(Sr);
    (n !== this.currentScheduler && ((this.currentScheduler = n), (this._dispatcher = void 0)),
      (this.currentSpan = gr(e, Ar)),
      (this.currentLogLevel = this.getRef(Mr)),
      (this.minimumLogLevel = this.getRef(Nr)),
      (this.currentStackFrame = this.getRef(jr)),
      (this.maxOpsBeforeYield = this.getRef(Or)),
      (this.currentPreventYield = this.getRef(kr)),
      (this.runtimeMetrics = gr(e, `effect/observability/Metric/FiberRuntimeMetricsKey`)));
    let r = gr(e, `effect/Tracer`);
    this.currentTracerContext = r ? r.context : void 0;
  }
  get currentSpanLocal() {
    return this.currentSpan?._tag === `Span` ? this.currentSpan : void 0;
  }
};
const Wr = {
    [j](e, t) {
      return Xr(t._interruptedCause);
    },
    [M](e, t) {
      return Xr(t._interruptedCause);
    },
  },
  Gr = { interruptChildren: void 0 },
  Kr = (e) => {
    if (!e.currentStackFrame) return;
    let t = new Map();
    return (t.set(Ft.key, e.currentStackFrame), sr(t));
  },
  qr = (e) =>
    oi((t) => {
      let n = e[Symbol.iterator](),
        r = [],
        i;
      function a() {
        let e = n.next();
        for (; !e.done; ) {
          if (e.value._exit) {
            (r.push(e.value._exit), (e = n.next()));
            continue;
          }
          i = e.value.addObserver((e) => {
            (r.push(e), a());
          });
          return;
        }
        t(Yr(r));
      }
      return (a(), Qr(() => i?.()));
    }),
  Jr = (e) =>
    zt((t) => {
      let n = Kr(t),
        r = En();
      for (let i of e) (i.interruptUnsafe(t.id, n), r.push(i));
      return di(qr(r));
    }),
  Yr = Nt,
  Xr = It,
  Zr = Lt,
  Qr = jt({
    op: `Sync`,
    [A](e) {
      let t = this[k](),
        n = e.getCont(j);
      return n ? n[j](t, e) : e.yieldWith(Nt(t));
    },
  }),
  $r = jt({
    op: `Suspend`,
    [A](e) {
      return this[k]();
    },
  }),
  ei = jt({
    op: `Yield`,
    [A](e) {
      let t = !1;
      return (
        e.currentDispatcher.scheduleTask(() => {
          t || e.evaluate(_i);
        }, this[k] ?? 0),
        e.yieldWith(() => {
          t = !0;
        })
      );
    },
  })(0),
  ti = (e) => $r(() => Xr(tt(e))),
  ni = (e) => Rt(e),
  ri = Yr(void 0),
  ii = jt({
    op: `Async`,
    single: !1,
    [A](e) {
      let t = tt(() => this[k][0].bind(e.currentScheduler)),
        n = !1,
        r = !1,
        i = this[k][1] ? new AbortController() : void 0,
        a = t((t) => {
          n || ((n = !0), r ? e.evaluate(t) : (r = t));
        }, i?.signal);
      return r === !1
        ? ((r = !0),
          (e._yielded = () => {
            n = !0;
          }),
          (i === void 0 && a === void 0) ||
            e._stack.push(ai(() => ((n = !0), i?.abort(), a ?? _i))),
          lt)
        : r;
    },
  }),
  ai = jt({
    op: `AsyncFinalizer`,
    [ct](e) {
      e.interruptible && ((e.interruptible = !1), e._stack.push(wi));
    },
    [M](e, t) {
      return Ir(e) ? N(this[k](), () => Xr(e)) : Xr(e);
    },
  }),
  oi = (e) => ii(e, e.length >= 2),
  si = (e, t) => Object.defineProperty(t, "length", { value: e, configurable: !0 }),
  ci = (e, ...t) =>
    si(
      e.length,
      t.length === 0
        ? function () {
            return li(() => e.apply(this, arguments));
          }
        : function () {
            let n = li(() => e.apply(this, arguments));
            for (let e of t) n = e(n);
            return n;
          },
    ),
  li = (e) => {
    try {
      let t = e(),
        n;
      for (;;) {
        let r = t.next(n);
        if (r.done) return Yr(r.value);
        let i = r.value;
        if (i && i._tag === `Success`) {
          n = i.value;
          continue;
        } else if (i && i._tag === `Failure`) return r.value;
        else {
          let n = !0;
          return $r(() => (n ? ((n = !1), N(r.value, (e) => ui(t, e))) : $r(() => ui(e()))));
        }
      }
    } catch (e) {
      return ni(e);
    }
  },
  ui = jt({
    op: `Iterator`,
    single: !1,
    [j](e, t) {
      let n = this[k][0];
      for (;;) {
        let r = n.next(e);
        if (r.done) return Yr(r.value);
        if (!P(r.value)) return (t._stack.push(this), r.value);
        if (r.value._tag === `Failure`) return r.value;
        e = r.value.value;
      }
    },
    [A](e) {
      return this[j](this[k][1], e);
    },
  }),
  di = (e) => N(e, (e) => _i),
  N = h(2, (e, t) => {
    let n = Object.create(fi);
    return ((n[k] = e), (n[j] = t.length === 1 ? t : (e) => t(e)), n);
  }),
  fi = At({
    op: `OnSuccess`,
    [A](e) {
      return (e._stack.push(this), this[k]);
    },
  }),
  P = (e) => at in e,
  pi = h(2, (e, t) => (P(e) ? (e._tag === `Success` ? t(e.value) : e) : N(e, t))),
  mi = h(2, (e, t) => N(e, (e) => Yr(tt(() => t(e))))),
  hi = h(2, (e, t) => (P(e) ? vi(e, t) : mi(e, t))),
  gi = (e) => e._tag === `Success`,
  _i = Nt(void 0),
  vi = h(2, (e, t) => (e._tag === `Success` ? Nt(t(e.value)) : e)),
  yi = h(2, (e, t) => {
    let n = Object.create(bi);
    return ((n[k] = e), (n[M] = t.length === 1 ? t : (e) => t(e)), n);
  }),
  bi = At({
    op: `OnFailure`,
    [A](e) {
      return (e._stack.push(this), this[k]);
    },
  }),
  xi = (e) => (P(e) ? Nt(e) : Si(e)),
  Si = jt({
    op: `Exit`,
    [A](e) {
      return (e._stack.push(this), this[k]);
    },
    [j](e, t, n) {
      return Yr(n ?? Nt(e));
    },
    [M](e, t, n) {
      return Yr(n ?? It(e));
    },
  }),
  Ci = (e) => zt((t) => (t.interruptible ? ((t.interruptible = !1), t._stack.push(wi), e) : e)),
  wi = jt({
    op: `SetInterruptible`,
    [ct](e) {
      if (((e.interruptible = this[k]), e._interruptedCause && e.interruptible))
        return () => Xr(e._interruptedCause);
    },
  })(!0),
  Ti = (e) => {
    let t = e.onItem,
      n = e.step,
      r = (e, i, a, o) => {
        for (; a < o; a++) {
          let s = i[a],
            c = t(e, s, a);
          if (!P(c)) return N(xi(c), (t) => n(e, s, t, a) ?? r(e, i, a + 1, o) ?? ri);
          let l = n(e, s, c, a);
          if (l) return l._tag === `Failure` ? l : void 0;
        }
      };
    return (e, i, a) => {
      let o = 0,
        s = a?.end ?? i.length,
        c = a?.concurrency ?? 1;
      if (c === 1) return r(e, i, 0, s);
      let l = a?.orderedStep === !0 && c > 1,
        u = !1,
        d,
        f,
        p,
        m = !1,
        h,
        g,
        _ = o,
        v = l ? Array(s) : void 0,
        y = (e) => {
          let t = Rt(e);
          return (
            (h = t), (u = !0), (m = !0), f && f.size > 0 ? N(Ci(Jr(Array.from(f))), () => t) : t
          );
        },
        ee = (t, r, a) => {
          if (!l) return n(e, t, r, a);
          if (h) return h;
          for (v[a] = r; _ < s; ) {
            let t = v[_];
            if (t === void 0) return;
            v[_] = void 0;
            let r = _++,
              a = n(e, i[r], t, r);
            if (a) return a;
          }
        },
        b = () => {
          let n = !1;
          for (; !h && o < s; o++) {
            let r = i[o],
              a = g ?? t(e, r, o);
            if (P(a)) {
              if (((h = ee(r, a, o)), h)) break;
            } else if (d) {
              g = void 0;
              let e = Di(d, a, !0, !0, `inherit`);
              if (e._exit) {
                if (((h = ee(r, e._exit, o)), h)) break;
                continue;
              }
              f.add(e);
              let t = o;
              if (
                (e.addObserver((i) => {
                  f.delete(e);
                  try {
                    if (h) {
                      if (!m && i._tag === `Failure`)
                        for (let e of i.cause.reasons)
                          if (e._tag === `Interrupt`) continue;
                          else h._tag === `Failure` ? h.cause.reasons.push(e) : (h = It(xt([e])));
                    } else {
                      let e = ee(r, i, t);
                      e && ((h = e._tag === `Failure` ? It(xt(e.cause.reasons.slice())) : e), b());
                    }
                    if (n) {
                      let e = b();
                      e && p(e);
                    } else u && f.size === 0 && p(h ?? ri);
                  } catch (e) {
                    p(y(e));
                  }
                }),
                f.size < c)
              )
                continue;
              ((n = !0), o++);
              return;
            } else
              return oi((e) => {
                ((d = Hr()), (f = new Set()), (g = a), (p = e));
                let t;
                try {
                  t = b();
                } catch (t) {
                  return e(y(t));
                }
                return t ? e(t) : $r(() => ((h = _i), (m = !0), f ? Jr(f) : ri));
              });
          }
          if (((u = !0), h)) {
            if (f && f.size > 0) {
              let e = Kr(d);
              f.forEach((t) => t.interruptUnsafe(d.id, e));
              return;
            }
            if (p || h._tag === `Failure`) return h;
          } else if (p)
            if (f) f.size === 0 && p(ri);
            else return _i;
        };
      return b();
    };
  },
  Ei = () => Ti,
  Di = (e, t, n = !1, r = !1, i = !1) => {
    let a = e,
      o = i === `inherit` ? a.interruptible : !i,
      s = new Ur(a.context, o);
    return (
      n ? s.evaluate(t) : a.currentDispatcher.scheduleTask(() => s.evaluate(t), 0),
      !r && !s._exit && (a.children().add(s), s.addObserver(() => a._children.delete(s))),
      s
    );
  },
  Oi = (e) => (t, n) => {
    let r = new Ur(n?.scheduler ? hr(e, Sr, n.scheduler) : e, n?.uninterruptible !== !0);
    if ((r.evaluate(t), r._exit)) return r;
    if (n?.signal)
      if (n.signal.aborted) r.interruptUnsafe();
      else {
        let e = () => r.interruptUnsafe();
        (n.signal.addEventListener(`abort`, e, { once: !0 }),
          r.addObserver(() => n.signal.removeEventListener(`abort`, e)));
      }
    return (n?.onFiberStart && n.onFiberStart(r), r);
  },
  ki = ((e) => {
    let t = Oi(e);
    return (e) => {
      if (P(e)) return e;
      let n = new Er(`sync`),
        r = t(e, { scheduler: n });
      return (r._dispatcher?.flush(), r._exit ?? Rt(new ji(r)));
    };
  })(fr());
(Ht(`TimeoutError`), Ht(`IllegalArgumentError`), Ht(`ExceededCapacityError`));
const Ai = `~effect/Cause/AsyncFiberError`;
var ji = class extends Ht(`AsyncFiberError`) {
  [Ai] = Ai;
  constructor(e) {
    super({ message: `An asynchronous Effect was executed with Effect.runSync`, fiber: e });
  }
};
Ht(`UnknownError`);
const Mi = {
  bold: `1`,
  red: `31`,
  green: `32`,
  yellow: `33`,
  blue: `34`,
  cyan: `36`,
  white: `37`,
  gray: `90`,
  black: `30`,
  bgBrightRed: `101`,
};
(Mi.gray, Mi.blue, Mi.green, Mi.yellow, Mi.red, Mi.bgBrightRed, Mi.black);
const Ni = Et,
  Pi = Rr;
(Zn()(`effect/Cause/StackTrace`), Zn()(`effect/Cause/InterruptorStackTrace`));
const Fi = Ht,
  Ii = Nt,
  Li = It,
  Ri = Lt,
  zi = _i,
  Bi = gi,
  Vi = `~effect/time/DateTime`,
  Hi = `~effect/time/DateTime/TimeZone`,
  Ui = {
    [Vi]: Vi,
    pipe() {
      return f(this, arguments);
    },
    [Qe]() {
      return this.toString();
    },
    toJSON() {
      return Gi(this).toJSON();
    },
  };
(({ ...Ui }), { ...Ui });
const Wi = {
  [Hi]: Hi,
  [Qe]() {
    return this.toString();
  },
};
(({ ...Wi }), { ...Wi });
const Gi = (e) => new Date(e.epochMilliseconds),
  Ki = Yr,
  F = Zr,
  qi = ti,
  Ji = N,
  Yi = xi,
  Xi = yi,
  Zi = ki;
Zn()(`effect/Effect/Transaction`);
const Qi = hi,
  $i = pi,
  ea = ci;
(Zn()(`effect/DateTime/CurrentTimeZone`), Fi(`EncodingError`));
function ta(e) {
  return e.checks ? e.checks[e.checks.length - 1].annotations : e.annotations;
}
function na(e) {
  return (t) => ta(t)?.[e];
}
const ra = na(`identifier`),
  ia = y((e) => {
    let t = ra(e);
    return typeof t == `string` ? t : e.getExpected(ia);
  }),
  aa = `~effect/SchemaIssue/Issue`;
function oa(e) {
  return x(e, aa) && e[aa] === aa;
}
var I = class {
    [aa] = aa;
    toString() {
      return Ta(this);
    }
  },
  sa = class extends I {
    _tag = `Filter`;
    filter;
    issue;
    constructor(e, t) {
      (super(), (this.filter = e), (this.issue = t));
    }
  },
  ca = class extends I {
    _tag = `Encoding`;
    ast;
    issue;
    constructor(e, t) {
      (super(), (this.ast = e), (this.issue = t));
    }
  },
  la = class extends I {
    _tag = `Pointer`;
    path;
    issue;
    constructor(e, t) {
      (super(), (this.path = e), (this.issue = t));
    }
  },
  ua = class extends I {
    _tag = `MissingKey`;
    annotations;
    constructor(e) {
      (super(), (this.annotations = e));
    }
  },
  da = class extends I {
    _tag = `UnexpectedKey`;
    ast;
    constructor(e) {
      (super(), (this.ast = e));
    }
  },
  L = class extends I {
    _tag = `Composite`;
    ast;
    issues;
    constructor(e, t) {
      (super(), (this.ast = e), (this.issues = t));
    }
  },
  fa = class extends I {
    _tag = `InvalidType`;
    ast;
    constructor(e) {
      (super(), (this.ast = e));
    }
  },
  pa = class extends I {
    _tag = `InvalidValue`;
    annotations;
    constructor(e) {
      (super(), (this.annotations = e));
    }
  },
  ma = class extends I {
    _tag = `AnyOf`;
    ast;
    issues;
    constructor(e, t) {
      (super(), (this.ast = e), (this.issues = t));
    }
  },
  ha = class extends I {
    _tag = `OneOf`;
    ast;
    successes;
    constructor(e, t) {
      (super(), (this.ast = e), (this.successes = t));
    }
  };
function ga(e) {
  if (oa(e)) return e;
  if (typeof e == `string`) return new pa({ message: e });
  let t = typeof e.issue == `string` ? new pa({ message: e.issue }) : e.issue;
  return new la(e.path, t);
}
function _a(e) {
  if (e !== void 0) return typeof e == `boolean` ? (e ? void 0 : new pa()) : ga(e);
}
function va(e, t) {
  return Array.isArray(t)
    ? Cn(t)
      ? t.length === 1
        ? ga(t[0])
        : new L(e, Dn(t, ga))
      : void 0
    : _a(t);
}
const ya = (e) => {
    let t = Da(e);
    if (t !== void 0) return t;
    switch (e._tag) {
      case `InvalidType`:
        return xa(ia(e.ast));
      case `InvalidValue`:
        return `Expected a valid value`;
      case `MissingKey`:
        return `Missing key`;
      case `UnexpectedKey`:
        return `Expected no excess property`;
      case `Forbidden`:
        return `Forbidden operation`;
      case `OneOf`:
        return `Expected exactly one member to match`;
    }
  },
  ba = (e) => Da(e.issue) ?? Da(e);
function xa(e) {
  return `Expected ${e}`;
}
function Sa(e, t, n, r) {
  switch (e._tag) {
    case `Filter`: {
      let i = r(e);
      if (i !== void 0) return [{ path: t, message: i }];
      switch (e.issue._tag) {
        case `InvalidValue`:
          return [{ path: t, message: xa(Ca(e.filter)) }];
        default:
          return Sa(e.issue, t, n, r);
      }
    }
    case `Encoding`:
      return Sa(e.issue, t, n, r);
    case `Pointer`:
      return Sa(e.issue, [...t, ...e.path], n, r);
    case `Composite`:
      return e.issues.flatMap((e) => Sa(e, t, n, r));
    case `AnyOf`:
      return e.issues.length === 0
        ? [{ path: t, message: Da(e) ?? xa(ia(e.ast)) }]
        : e.issues.flatMap((e) => Sa(e, t, n, r));
    default:
      return [{ path: t, message: n(e) }];
  }
}
function Ca(e) {
  let t = e.annotations?.expected;
  if (typeof t == `string`) return t;
  switch (e._tag) {
    case `Filter`:
      return `<filter>`;
    case `FilterGroup`:
      return e.checks.map((e) => Ca(e)).join(` & `);
  }
}
function wa() {
  return (e) =>
    Sa(e, [], ya, ba).map(Ea).join(`
`);
}
const Ta = wa();
function Ea(e) {
  let t = e.message;
  if (e.path && e.path.length > 0) {
    let n = Ye(e.path);
    t += `\n  at ${n}`;
  }
  return t;
}
function Da(e) {
  switch (e._tag) {
    case `InvalidType`:
    case `OneOf`:
    case `Composite`:
    case `AnyOf`:
      return Oa(e.ast.annotations);
    case `InvalidValue`:
    case `Forbidden`:
      return Oa(e.annotations);
    case `MissingKey`:
      return Oa(e.annotations, `messageMissingKey`);
    case `UnexpectedKey`:
      return Oa(e.ast.annotations, `messageUnexpectedKey`);
    case `Filter`:
      return Oa(e.filter.annotations);
    case `Encoding`:
      return Da(e.issue);
  }
}
function Oa(e, t = `message`) {
  let n = e?.[t];
  if (typeof n == `string`) return n;
}
function ka(e) {
  let t;
  for (let n of e.reasons) {
    if (!Ni(n) || !oa(n.error)) return;
    t ??= n.error;
  }
  return t;
}
function Aa(e, t) {
  let n = ka(e);
  if (n === void 0) throw Error(t, { cause: e });
  return n;
}
const R = Symbol(),
  ja = Ii,
  Ma = ja(R),
  z = ja(R),
  Na = (e) => (e === R ? mn() : hn(e)),
  Pa = (e) => (e._tag === `None` ? Ma : ja(e.value));
var Fa = class e extends m {
  run;
  constructor(e) {
    (super(), (this.run = e));
  }
  map(t) {
    return new e((e, n) => this.run(e, n).pipe(Qi(_n(t))));
  }
  compose(t) {
    return La(this)
      ? t
      : La(t)
        ? this
        : new e((e, n) => this.run(e, n).pipe($i((e) => t.run(e, n))));
  }
};
const Ia = new Fa(Ki);
function La(e) {
  return e.run === Ia.run;
}
function Ra() {
  return Ia;
}
function B(e) {
  return za(_n(e));
}
function za(e) {
  return new Fa((t) => Ki(e(t)));
}
function Ba() {
  return B(globalThis.String);
}
function Va() {
  return B(globalThis.Number);
}
const Ha = `~effect/SchemaTransformation/Transformation`;
var Ua = class e {
  [Ha] = Ha;
  _tag = `Transformation`;
  decode;
  encode;
  constructor(e, t) {
    ((this.decode = e), (this.encode = t));
  }
  flip() {
    return new e(this.encode, this.decode);
  }
  compose(t) {
    return new e(this.decode.compose(t.decode), t.encode.compose(this.encode));
  }
};
function Wa(e) {
  return x(e, Ha) && e[Ha] === Ha;
}
const Ga = (e) => (Wa(e) ? e : new Ua(e.decode, e.encode)),
  Ka = new Ua(Ra(), Ra());
function qa() {
  return Ka;
}
const Ja = new Ua(Va(), Ba());
function Ya(e) {
  return (t) => t._tag === e;
}
const Xa = Ya(`Declaration`),
  Za = Ya(`Never`),
  Qa = Ya(`Literal`),
  $a = Ya(`UniqueSymbol`),
  eo = Ya(`Arrays`),
  to = Ya(`Objects`),
  no = Ya(`Suspend`);
var V = class {
  to;
  transformation;
  constructor(e, t) {
    ((this.to = e), (this.transformation = t));
  }
};
const ro = {};
var io = class {
  isOptional;
  isMutable;
  defaultValue;
  annotations;
  constructor(e, t, n = void 0, r = void 0) {
    ((this.isOptional = e), (this.isMutable = t), (this.defaultValue = n), (this.annotations = r));
  }
};
const ao = `~effect/Schema`;
var H = class {
  [ao] = ao;
  annotations;
  checks;
  encoding;
  context;
  constructor(e = void 0, t = void 0, n = void 0, r = void 0) {
    ((this.annotations = e), (this.checks = t), (this.encoding = n), (this.context = r));
  }
  toString() {
    return `<${this._tag}>`;
  }
};
const oo = new (class extends H {
  _tag = `Null`;
  getParser() {
    return Os(this, null);
  }
  getExpected() {
    return `null`;
  }
})();
var so = class extends H {
  _tag = `Undefined`;
  getParser() {
    return Os(this, void 0);
  }
  toCodecJson() {
    return U(this, [co]);
  }
  getExpected() {
    return `undefined`;
  }
};
const co = new V(
    oo,
    new Ua(
      B(() => void 0),
      B(() => null),
    ),
  ),
  lo = new so(),
  uo = new (class extends H {
    _tag = `Unknown`;
    getParser() {
      return ks(this, le);
    }
    getExpected() {
      return `unknown`;
    }
  })();
var fo = class extends H {
  _tag = `Literal`;
  literal;
  constructor(e, t, n, r, i) {
    if ((super(t, n, r, i), typeof e == `number` && !globalThis.Number.isFinite(e)))
      throw Error(`A numeric literal must be finite, got ${O(e)}`);
    this.literal = e;
  }
  getParser() {
    return Os(this, this.literal);
  }
  matchPart(e, t) {
    return e === globalThis.String(this.literal) ? this.literal : void 0;
  }
  toCodecJson() {
    return typeof this.literal == `bigint` ? po(this) : this;
  }
  toCodecStringTree() {
    return typeof this.literal == `string` ? this : po(this);
  }
  getExpected() {
    return typeof this.literal == `string`
      ? JSON.stringify(this.literal)
      : globalThis.String(this.literal);
  }
};
function po(e) {
  let t = globalThis.String(e.literal);
  return U(e, [
    new V(
      new fo(t),
      new Ua(
        B(() => e.literal),
        B(() => t),
      ),
    ),
  ]);
}
const mo = new (class extends H {
  _tag = `String`;
  getParser() {
    return ks(this, ne);
  }
  matchPart(e, t) {
    let n = this.checks;
    return n && !t.disableChecks && Ls(n, e, void 0, this, t) ? void 0 : e;
  }
  getExpected() {
    return `string`;
  }
})();
var ho = class extends H {
  _tag = `Number`;
  getParser() {
    return ks(this, re);
  }
  matchKey(e, t) {
    return this._match(Ms, e, t);
  }
  matchPart(e, t) {
    return this._match(js, e, t);
  }
  _match(e, t, n) {
    if (!e.test(t)) return;
    let r = globalThis.Number(t);
    return n.disableChecks || !this.checks ? r : Ls(this.checks, r, void 0, this, n) ? void 0 : r;
  }
  toCodecJson() {
    return this.checks &&
      (go(this.checks, `effect/schema/isFinite`) || go(this.checks, `effect/schema/isInt`))
      ? this
      : U(this, [_o(this.checks)]);
  }
  toCodecStringTree() {
    return this.toCodecJson() === this ? U(this, [Fs]) : U(this, [Is]);
  }
  getExpected() {
    return `number`;
  }
};
function go(e, t) {
  return e.some(
    (e) => e.annotations?.representation?.id === t || (e._tag === `FilterGroup` && go(e.checks, t)),
  );
}
function _o(e) {
  return new V(
    new Go([e ? ss(ts, e) : ts, Jo], `anyOf`),
    new Ua(
      Va(),
      B((e) => (globalThis.Number.isFinite(e) ? e : globalThis.String(e))),
    ),
  );
}
const vo = new ho(),
  yo = new (class extends H {
    _tag = `Boolean`;
    getParser() {
      return ks(this, ie);
    }
    getExpected() {
      return `boolean`;
    }
  })();
var bo = class e extends H {
  _tag = `Arrays`;
  isMutable;
  elements;
  rest;
  encodingChecks;
  constructor(e, t, n, r, i, a, o, s) {
    (super(r, i, a, o),
      (this.isMutable = e),
      (this.elements = t),
      (this.rest = n),
      (this.encodingChecks = s));
    let c = !1;
    for (let e = 0; e < t.length; e++)
      if (bs(t[e])) c = !0;
      else if (c) throw Error(`A required element cannot follow an optional element. ts(1257)`);
    if (c && n.length > 1)
      throw Error(`A required element cannot follow an optional element. ts(1257)`);
    for (let e = 1; e < n.length; e++)
      if (bs(n[e])) throw Error(`An optional element cannot follow a rest element. ts(1266)`);
  }
  getParser(e) {
    let t = this,
      n,
      r,
      i = t.elements.length,
      a = Math.max(0, t.rest.length - 1);
    function o(e, t) {
      return t < i ? n[t] : t >= e ? r[t - e + 1] : r[0];
    }
    return ea(function* (s, c) {
      if (s === R) return R;
      if (!Array.isArray(s)) return yield* F(new fa(t));
      n ||
        ((n = t.elements.map((t) => ({ ast: t, parser: e(t) }))),
        (r = t.rest.map((t) => ({ ast: t, parser: e(t) }))));
      let l = s.length,
        u = {
          ast: t,
          getParser: o,
          input: s,
          len: l,
          tailThreshold: Math.max(i, l - a),
          output: new globalThis.Array(l),
          issues: void 0,
          options: c,
        },
        d = So(c?.concurrency),
        f = xo(u, s, {
          concurrency: d?.concurrency,
          end: t.rest.length === 0 ? i : Math.max(l, i + a),
        });
      if ((f && (yield* f), t.rest.length === 0 && l > i))
        for (let e = i; e <= l - 1; e++) {
          let n = new la([e], new da(t));
          if (c.errors === `all`) u.issues ? u.issues.push(n) : (u.issues = [n]);
          else return yield* F(new L(t, [n]));
        }
      return u.issues ? yield* F(new L(t, u.issues)) : u.output;
    });
  }
  _rebuild(t, n, r) {
    let i = ps(this.elements, t),
      a = ps(this.rest, t);
    return i === this.elements && a === this.rest && n === this.checks && r === this.encodingChecks
      ? this
      : new e(this.isMutable, i, a, this.annotations, n, void 0, this.context, r);
  }
  recur(e) {
    return this._rebuild(e, this.checks, this.encodingChecks);
  }
  flip(e) {
    return this._rebuild(e, this.encodingChecks, this.checks);
  }
  getExpected() {
    return `array`;
  }
};
const xo = Ei()({
    onItem(e, t, n) {
      let r = n < e.len ? t : R;
      return e.getParser(e.tailThreshold, n).parser(r, e.options);
    },
    step(e, t, n, r) {
      if (n._tag === `Failure`) return Co(e, e.ast, r, n);
      let i = n === z ? t : n[k];
      if (i !== R) e.output[r] = i;
      else {
        let t = e.getParser(e.tailThreshold, r);
        if (bs(t.ast)) return;
        let n = new la([r], new ua(t.ast.context?.annotations));
        if (e.options.errors === `all`) e.issues ? e.issues.push(n) : (e.issues = [n]);
        else return Ri(new L(e.ast, [n]));
      }
    },
  }),
  So = (e) => ((e = e === `unbounded` ? 1 / 0 : (e ?? 1)), e > 1 ? { concurrency: e } : void 0),
  Co = (e, t, n, r) => {
    if (r.cause.reasons.length === 0) return r;
    let i = ka(r.cause);
    if (i === void 0) return Li(Pi(r.cause, (e) => new L(t, [new la([n], e)])));
    let a = new la([n], i);
    if (e.options.errors === `all`) e.issues ? e.issues.push(a) : (e.issues = [a]);
    else return Ri(new L(t, [a]));
  },
  wo = `[+-]?\\d*\\.?\\d+(?:[Ee][+-]?\\d+)?`;
function To(e, t, n = ro) {
  let r, i;
  function a(t) {
    switch (t._tag) {
      case `String`:
      case `TemplateLiteral`:
        return (r ??= Object.keys(e)).filter((e) => t.matchPart(e, n) !== void 0);
      case `Number`:
        return (r ??= Object.keys(e)).filter((e) => t.matchKey(e, n) !== void 0);
      case `Symbol`:
        return (i ??= Object.getOwnPropertySymbols(e)).filter((e) => t.matchKey(e, n) !== void 0);
      case `Union`:
        return [...new Set(t.types.flatMap(a))];
      default:
        return [];
    }
  }
  return a(As(ws(t)));
}
var Eo = class {
  name;
  type;
  constructor(e, t) {
    ((this.name = e), (this.type = t));
  }
};
function Do(e) {
  switch (e._tag) {
    case `String`:
    case `Number`:
    case `Symbol`:
    case `TemplateLiteral`:
      return !0;
    case `Union`:
      return e.types.every(Do);
    default:
      return !1;
  }
}
function Oo(e) {
  return Do(e) && Do(ws(e));
}
var ko = class {
    parameter;
    type;
    constructor(e, t) {
      if (!Oo(e)) throw Error(`Invalid index signature parameter ${e._tag}`);
      if (((this.parameter = e), (this.type = t), bs(t) && !Ds(t)))
        throw Error(
          "Cannot use `Schema.optionalKey` with index signatures, use `Schema.optional` instead.",
        );
    }
  },
  Ao = class e extends H {
    _tag = `Objects`;
    propertySignatures;
    indexSignatures;
    encodingChecks;
    constructor(e, t, n, r, i, a, o) {
      (super(n, r, i, a),
        (this.propertySignatures = e),
        (this.indexSignatures = t),
        (this.encodingChecks = o));
      let s = e.map((e) => e.name).filter((e, t, n) => n.indexOf(e) !== t);
      if (s.length > 0) throw Error(`Duplicate identifiers: ${JSON.stringify(s)}. ts(2300)`);
    }
    getParser(e) {
      let t = this,
        n = [];
      for (let e of t.propertySignatures) n.push(e.name);
      let r = n.length,
        i = t.indexSignatures.length,
        a = r && i ? new Set(n) : void 0;
      if (!r && !i) return ks(t, ce);
      let o,
        s,
        c = (e, n, i, o, s) => {
          if (s._tag === `Failure`) return Co(e, t, n, s) ?? zi;
          let c = s === z ? o : s[k];
          if (i !== R && c !== R) {
            if (r && (a.has(n) || a.has(i))) return zi;
            nt(e.out, i, c);
          }
          return zi;
        },
        l = (e, n, r, i) => {
          if (!i) {
            let t = r.parserKey(n, e.options);
            if (!P(t)) return Ji(Yi(t), (t) => l(e, n, r, t));
            i = t;
          }
          if (i._tag === `Failure`) return Co(e, t, n, i) ?? zi;
          let a = i === z ? n : i[k],
            o = e.input[n],
            s = r.parserValue(o, e.options);
          return P(s) ? c(e, n, a, o, s) : Ji(Yi(s), (t) => c(e, n, a, o, t));
        },
        u = (e, t, n) => {
          let r = e.input[t],
            i = n.parserValue(r, e.options);
          return P(i) ? c(e, t, t, r, i) : Ji(Yi(i), (n) => c(e, t, t, r, n));
        },
        d = i
          ? Ei()({
              onItem: (e, [t, n]) => l(e, t, n),
              step: (e, t, n) => (n._tag === `Failure` ? n : void 0),
            })
          : void 0;
      return ea(function* (c, f) {
        if (c === R) return R;
        if (!(typeof c == `object` && c && !Array.isArray(c))) return yield* F(new fa(t));
        o ||
          ((o = t.propertySignatures.map((t) => ({
            parser: e(t.type),
            name: t.name,
            type: t.type,
          }))),
          (s = i
            ? t.indexSignatures.map((t) => ({
                is: t,
                parserKey: e(As(t.parameter)),
                parserValue: e(t.type),
              }))
            : void 0));
        let p = c,
          m = {},
          h = { ast: t, input: p, out: m, issues: void 0, options: f },
          g = f.errors === `all`,
          _ = f.onExcessProperty === `error`,
          v = f.onExcessProperty === `preserve`,
          y;
        if (!i && (_ || v)) {
          ((a ??= new Set(n)), (y = Reflect.ownKeys(p)));
          for (let e = 0; e < y.length; e++) {
            let n = y[e];
            if (!a.has(n))
              if (_) {
                let e = new la([n], new da(t));
                if (g) {
                  h.issues ? h.issues.push(e) : (h.issues = [e]);
                  continue;
                } else return yield* F(new L(t, [e]));
              } else nt(m, n, p[n]);
          }
        }
        let ee = So(f?.concurrency);
        if (r) {
          let e = jo(h, o, ee);
          e && (yield* e);
        }
        if (i && !ee)
          for (let e = 0; e < i; e++) {
            let t = s[e],
              n = t.is.parameter === mo ? u : l,
              r = t.is.parameter === mo ? Object.keys(p) : To(p, t.is.parameter, f);
            for (let e = 0; e < r.length; e++) {
              let i = n(h, r[e], t);
              if (!P(i)) yield* i;
              else if (i._tag === `Failure`) return yield* i;
            }
          }
        else if (d) {
          let e = En();
          for (let t = 0; t < i; t++) {
            let n = s[t],
              r = To(p, n.is.parameter, f);
            for (let t = 0; t < r.length; t++) e.push([r[t], n]);
          }
          let t = d(h, e, ee);
          t && (yield* t);
        }
        if (h.issues) return yield* F(new L(t, h.issues));
        if (f.propertyOrder === `original`) {
          let e = (y ?? Reflect.ownKeys(p)).concat(n),
            t = {};
          for (let n of e) Object.hasOwn(m, n) && nt(t, n, m[n]);
          return t;
        }
        return m;
      });
    }
    _rebuild(t, n, r, i) {
      let a = ps(this.propertySignatures, (e) => {
          let n = t(e.type);
          return n === e.type ? e : new Eo(e.name, n);
        }),
        o = ps(this.indexSignatures, (e) => {
          let r = n(e.parameter),
            i = t(e.type);
          return r === e.parameter && i === e.type ? e : new ko(r, i);
        });
      return a === this.propertySignatures &&
        o === this.indexSignatures &&
        r === this.checks &&
        i === this.encodingChecks
        ? this
        : new e(a, o, this.annotations, r, void 0, this.context, i);
    }
    flip(e) {
      return this._rebuild(e, e, this.encodingChecks, this.checks);
    }
    recur(e, t = e) {
      return this._rebuild(e, t, this.checks, this.encodingChecks);
    }
    getExpected() {
      return this.propertySignatures.length === 0 && this.indexSignatures.length === 0
        ? `object | array`
        : `object`;
    }
  };
const jo = Ei()({
  onItem(e, t) {
    if (!Object.hasOwn(e.input, t.name)) return t.parser(R, e.options);
    let n = e.input[t.name];
    return (nt(e.out, t.name, n), t.parser(n, e.options));
  },
  step(e, t, n) {
    if (n._tag === `Failure`) return Co(e, e.ast, t.name, n);
    if (n === z) return;
    let r = n[k];
    if (r !== R) {
      nt(e.out, t.name, r);
      return;
    }
    if ((delete e.out[t.name], !bs(t.type))) {
      let n = new la([t.name], new ua(t.type.context?.annotations));
      if (e.options.errors === `all`) {
        e.issues ? e.issues.push(n) : (e.issues = [n]);
        return;
      } else return Ri(new L(e.ast, [n]));
    }
  },
});
function Mo(e, t) {
  return e ? (t ? [...e, ...t] : e) : t;
}
function No(e, t, n) {
  return new Ao(
    Reflect.ownKeys(e).map((t) => new Eo(t, e[t].ast)),
    [],
    n,
    t,
  );
}
function Po(e) {
  return e.ast;
}
function Fo(e, t = void 0) {
  return new bo(
    !1,
    e.map((e) => e.ast),
    [],
    void 0,
    t,
  );
}
function Io(e, t, n) {
  return new Go(e.map(Po), t, void 0, n);
}
const Lo = y((e) => {
  for (;;) {
    if (no(e)) return uo;
    let t = e.encoding;
    if (!t) return e.recur?.(Lo, g) ?? e;
    if (t.some((e) => e.transformation._tag === `Middleware` && e.transformation.decode !== g))
      return uo;
    e = t[t.length - 1].to;
  }
});
function Ro(e) {
  switch (e._tag) {
    case `Null`:
      return [`null`];
    case `Undefined`:
      return [`undefined`];
    case `String`:
    case `TemplateLiteral`:
      return [`string`];
    case `Number`:
      return [`number`];
    case `Boolean`:
      return [`boolean`];
    case `Symbol`:
    case `UniqueSymbol`:
      return [`symbol`];
    case `BigInt`:
      return [`bigint`];
    case `Arrays`:
      return [`array`];
    case `ObjectKeyword`:
      return [`object`, `array`, `function`];
    case `Objects`:
      return e.propertySignatures.length || e.indexSignatures.length
        ? [`object`]
        : [`string`, `number`, `boolean`, `symbol`, `bigint`, `object`, `array`, `function`];
    case `Enum`:
      return Array.from(new Set(e.enums.map(([, e]) => typeof e)));
    case `Literal`:
      return [typeof e.literal];
    case `Union`:
      return Array.from(new Set(e.types.flatMap(Ro)));
    default:
      return [
        `null`,
        `undefined`,
        `string`,
        `number`,
        `boolean`,
        `symbol`,
        `bigint`,
        `object`,
        `array`,
        `function`,
      ];
  }
}
function zo(e) {
  switch (e._tag) {
    default:
      return [];
    case `Declaration`: {
      let t = e.annotations?.[`~sentinels`];
      return Array.isArray(t) ? t : [];
    }
    case `Objects`:
      return e.propertySignatures.flatMap((e) => {
        let t = e.type;
        if (!bs(t)) {
          if (Qa(t)) return [{ key: e.name, literal: t.literal }];
          if ($a(t)) return [{ key: e.name, literal: t.symbol }];
        }
        return [];
      });
    case `Arrays`:
      return e.elements.flatMap((e, t) => {
        if (!bs(e)) {
          if (Qa(e)) return [{ key: t, literal: e.literal }];
          if ($a(e)) return [{ key: t, literal: e.symbol }];
        }
        return [];
      });
    case `Suspend`:
      return zo(e.thunk());
  }
}
const Bo = new WeakMap(),
  Vo = Object.freeze([]);
function Ho(e) {
  let t = Bo.get(e);
  if (t) return t;
  t = {};
  let n;
  for (let r = 0; r < e.length; r++) {
    let i = e[r],
      a = Lo(i);
    if (Za(a)) continue;
    if (n !== null)
      if (Qa(a) || $a(a)) {
        n ??= new Map();
        let e = Qa(a) ? a.literal : a.symbol,
          t = n.get(e);
        (t || n.set(e, (t = [])), t.push(i));
      } else n = null;
    let o = zo(a);
    if (o.length) {
      t.bySentinel ??= new Map();
      for (let { key: e, literal: n } of o) {
        let i = t.bySentinel.get(e);
        i || t.bySentinel.set(e, (i = new Map()));
        let a = i.get(n);
        (a || i.set(n, (a = [])), a[a.length - 1] !== r && a.push(r));
      }
    } else {
      t.otherwise ??= {};
      let e = Ro(a);
      for (let n of e) (t.otherwise[n] ??= []).push(r);
    }
  }
  if (n) (n.forEach(Object.freeze), (t = (e) => n.get(e) ?? Vo));
  else if (t.bySentinel?.size === 1 && !t.otherwise)
    for (let [n, r] of t.bySentinel) {
      let i = r;
      for (let [t, n] of r) i.set(t, Object.freeze(n.map((t) => e[t])));
      t = (e) => (ue(e) && Object.hasOwn(e, n) ? (i.get(e[n]) ?? Vo) : Vo);
    }
  return (Bo.set(e, t), t);
}
function Uo(e) {
  return (t) => {
    let n = Lo(t);
    return n._tag === `Literal` ? n.literal === e : n._tag === `UniqueSymbol` ? n.symbol === e : !0;
  };
}
function Wo(e, t) {
  let n = Ho(t);
  if (typeof n == `function`) return n(e);
  let r = e === null ? `null` : Array.isArray(e) ? `array` : typeof e;
  if (n.bySentinel) {
    let i = n.otherwise?.[r] ?? Vo;
    if (ue(e)) {
      let r = new Set(i);
      for (let [t, i] of n.bySentinel)
        if (Object.hasOwn(e, t)) {
          let n = i.get(e[t]);
          if (n) for (let e of n) r.add(e);
        }
      return Array.from(r)
        .sort((e, t) => e - t)
        .map((e) => t[e]);
    }
    return i.map((e) => t[e]);
  }
  return (n.otherwise?.[r] ?? Vo).map((e) => t[e]).filter(Uo(e));
}
var Go = class e extends H {
  _tag = `Union`;
  types;
  mode;
  encodingChecks;
  constructor(e, t, n, r, i, a, o) {
    (super(n, r, i, a), (this.types = e), (this.mode = t), (this.encodingChecks = o));
  }
  getParser(e) {
    let t = this;
    return (n, r) => {
      if (n === R) return Ma;
      let i = Wo(n, t.types);
      if (i.length === 1) {
        let a = e(i[0])(n, r);
        return a._tag === `Success` ? a : P(a) ? Ko(t, a.cause) : Xi(a, (e) => Ko(t, e));
      }
      let a = {
          ast: t,
          recur: e,
          input: n,
          out: void 0,
          successes: t.mode === `oneOf` ? [] : void 0,
          issues: void 0,
          options: r,
        },
        o = So(r?.concurrency),
        s = qo(a, i, o ? { ...o, orderedStep: !0 } : void 0);
      return s
        ? $i(s, (e) => (a.out === z ? Ki(n) : (a.out ?? F(new ma(t, a.issues ?? [])))))
        : (a.out ?? F(new ma(t, a.issues ?? [])));
    };
  }
  _rebuild(t, n, r) {
    let i = ps(this.types, t);
    return i === this.types && n === this.checks && r === this.encodingChecks
      ? this
      : new e(i, this.mode, this.annotations, n, void 0, this.context, r);
  }
  recur(e) {
    return this._rebuild(e, this.checks, this.encodingChecks);
  }
  flip(e) {
    return this._rebuild(e, this.encodingChecks, this.checks);
  }
  matchPart(e, t) {
    for (let n of this.types) {
      let r = n.matchPart(e, t);
      if (r !== void 0) return r;
    }
  }
  getExpected(e) {
    let t = this.annotations?.expected;
    if (typeof t == `string`) return t;
    if (this.types.length === 0) return `never`;
    let n = this.types.map((t) => {
      let n = ws(t);
      switch (n._tag) {
        case `Arrays`: {
          let t = n.elements.filter(Qa);
          if (t.length > 0)
            return `${Yo(n.isMutable)}[ ${t.map((t) => e(t) + Xo(t.context?.isOptional)).join(`, `)}, ... ]`;
          break;
        }
        case `Objects`: {
          let t = n.propertySignatures.filter((e) => Qa(e.type));
          if (t.length > 0)
            return `{ ${t.map((t) => `${Yo(t.type.context?.isMutable)}${Je(t.name)}${Xo(t.type.context?.isOptional)}: ${e(t.type)}`).join(`, `)}, ... }`;
          break;
        }
      }
      return e(n);
    });
    return Array.from(new Set(n)).join(` | `);
  }
};
function Ko(e, t) {
  let n = ka(t);
  return n ? Ri(new ma(e, [n])) : Li(t);
}
const qo = Ei()({
    onItem(e, t) {
      return e.recur(t)(e.input, e.options);
    },
    step(e, t, n) {
      if (n._tag === `Failure`) {
        let t = ka(n.cause);
        if (t === void 0) return n;
        e.issues ? e.issues.push(t) : (e.issues = [t]);
      } else {
        if (e.out && e.successes) return (e.successes.push(t), Ri(new ha(e.ast, e.successes)));
        if (((e.out = n), e.successes)) e.successes.push(t);
        else return zi;
      }
    },
  }),
  Jo = new Go([new fo(`Infinity`), new fo(`-Infinity`), new fo(`NaN`)], `anyOf`);
function Yo(e) {
  return e ? `` : `readonly `;
}
function Xo(e) {
  return e ? `?` : ``;
}
var Zo = class e extends m {
    _tag = `Filter`;
    run;
    annotations;
    aborted;
    constructor(e, t = void 0, n = !1) {
      (super(), (this.run = e), (this.annotations = t), (this.aborted = n));
    }
    annotate(t) {
      return new e(this.run, { ...this.annotations, ...t }, this.aborted);
    }
    abort() {
      return new e(this.run, this.annotations, !0);
    }
    and(e, t) {
      return new Qo([this, e], t);
    }
  },
  Qo = class e extends m {
    _tag = `FilterGroup`;
    checks;
    annotations;
    constructor(e, t = void 0) {
      (super(), (this.checks = e), (this.annotations = t));
    }
    annotate(t) {
      return new e(this.checks, { ...this.annotations, ...t });
    }
    and(t, n) {
      return new e([this, t], n);
    }
  };
function $o(e, t, n = !1) {
  return new Zo((t, n, r) => va(n, e(t, n, r)), t, n);
}
function es(e) {
  return $o((e) => globalThis.Number.isFinite(e), {
    expected: `a finite number`,
    representation: { id: `effect/schema/isFinite`, payload: null },
    toJsonSchema: () => ({ type: `number` }),
    toCode: () => ({ runtime: `Schema.isFinite()` }),
    arbitrary: { constraint: { noInfinity: !0, noNaN: !0 } },
    ...e,
  });
}
const ts = ss(vo, [es()]);
function ns(e, t) {
  let n = e.source,
    r = new globalThis.RegExp(n, e.flags);
  return $o((e) => ((r.lastIndex = 0), r.test(e)), {
    expected: `a string matching the RegExp ${n}`,
    representation: { id: `effect/schema/isPattern`, payload: { source: n, flags: e.flags } },
    toJsonSchema: () => ({ pattern: n }),
    arbitrary: { constraint: { patterns: [e.source] } },
    ...t,
  });
}
function rs(e, t) {
  let n = Object.getOwnPropertyDescriptors(e);
  return (t(n), Object.create(Object.getPrototypeOf(e), n));
}
function U(e, t) {
  return e.encoding === t
    ? e
    : rs(e, (e) => {
        e.encoding.value = t;
      });
}
function is(e, t) {
  return e.context === t
    ? e
    : rs(e, (e) => {
        e.context.value = t;
      });
}
function as(e, t) {
  if (e.checks) {
    let n = e.checks[e.checks.length - 1];
    return os(e, bn(e.checks.slice(0, -1), n.annotate(t)));
  }
  return rs(e, (e) => {
    e.annotations.value = { ...e.annotations.value, ...t };
  });
}
function os(e, t) {
  if (e._tag === `Suspend` && t) throw Error(`Cannot add checks to Suspend`);
  return e.checks === t
    ? e
    : rs(e, (e) => {
        e.checks.value = t;
      });
}
function ss(e, t) {
  return os(e, Mo(e.checks, t));
}
function cs(e, t) {
  let n = t(e.to);
  return n === e.to ? e : new V(n, e.transformation);
}
function ls(e, t) {
  let n = e,
    r = n[n.length - 1],
    i = cs(r, t);
  return i === r ? e : bn(e.slice(0, e.length - 1), i);
}
function us(e) {
  return (t) => (t.encoding ? U(t, ls(t.encoding, e)) : t);
}
function ds(e) {
  function t(n) {
    return n.encoding ? U(n, ls(n.encoding, t)) : e(n);
  }
  return y(t);
}
function fs(e, t, n) {
  let r = new V(e, t);
  return U(n, n.encoding ? [...n.encoding, r] : [r]);
}
function ps(e, t) {
  let n = !1,
    r = Array(e.length);
  for (let i = 0; i < e.length; i++) {
    let a = e[i],
      o = t(a);
    (o !== a && (n = !0), (r[i] = o));
  }
  return n ? r : e;
}
function ms(e, t) {
  return is(
    e,
    e.context
      ? new io(e.context.isOptional, e.context.isMutable, e.context.defaultValue, {
          ...e.context.annotations,
          ...t,
        })
      : new io(!1, !1, void 0, t),
  );
}
const hs = us(gs);
function gs(e) {
  let t = e.context
    ? e.context.isOptional === !1
      ? new io(!0, e.context.isMutable, e.context.defaultValue, e.context.annotations)
      : e.context
    : new io(!0, !1);
  return hs(is(e, t));
}
function _s(e, t, n) {
  return fs(e, n, t);
}
function vs(e) {
  let t = [],
    n = [];
  function r(e) {
    switch (e._tag) {
      case `Literal`:
        oe(e.literal) && t.push(e.literal);
        return;
      case `UniqueSymbol`:
        t.push(e.symbol);
        return;
      case `Never`:
        return;
      case `Union`:
        for (let t = 0; t < e.types.length; t++) r(e.types[t]);
        return;
      default:
        n.push(e);
    }
  }
  return (r(e), { literals: t, parameters: n });
}
function ys(e, t) {
  let { literals: n, parameters: r } = vs(e);
  return new Ao(
    n.map((e) => new Eo(e, t)),
    r.map((e) => new ko(e, t)),
  );
}
function bs(e) {
  return e.context?.isOptional ?? !1;
}
function xs(e) {
  return e.annotations?.[`~structural`] === !0 || (e._tag === `FilterGroup` && e.checks.every(xs));
}
function Ss(e) {
  function t(e) {
    return xs(e) ? [e] : e._tag === `FilterGroup` ? e.checks.flatMap(t) : [];
  }
  let n = e.flatMap(t);
  return Sn(n) ? n : void 0;
}
const Cs = y((e) => {
    if (e.encoding) return Cs(U(e, void 0));
    let t = e,
      n = t.recur?.(Cs) ?? t,
      r = n.encodingChecks;
    if (r) {
      let t =
        n === e ? r : eo(n) || to(n) || (Xa(n) && n.typeParameters.length > 0) ? Ss(r) : void 0;
      return rs(n, (e) => {
        ((e.encodingChecks.value = void 0), (e.checks.value = Mo(n.checks, t)));
      });
    }
    return n;
  }),
  ws = y((e) => Cs(Es(e)));
function Ts(e, t) {
  let n = t,
    r = n.length,
    i = n[r - 1],
    a = [new V(Es(U(e, void 0)), n[0].transformation.flip())];
  for (let e = 1; e < r; e++) a.unshift(new V(Es(n[e - 1].to), n[e].transformation.flip()));
  let o = Es(i.to);
  return o.encoding ? U(o, [...o.encoding, ...a]) : U(o, a);
}
const Es = y((e) => {
  if (e.encoding) return Ts(e, e.encoding);
  let t = e;
  return t.flip?.(Es) ?? t.recur?.(Es) ?? t;
});
function Ds(e) {
  switch (e._tag) {
    case `Undefined`:
      return !0;
    case `Union`:
      return e.types.some(Ds);
    default:
      return !1;
  }
}
function Os(e, t) {
  let n = ja(t);
  return (r) => (r === R ? Ma : r === t ? n : F(new fa(e)));
}
function ks(e, t) {
  return (n) => (n === R ? Ma : t(n) ? z : F(new fa(e)));
}
const As = ds((e) => {
    switch (e._tag) {
      default:
        return e;
      case `Number`:
        return e.toCodecStringTree();
      case `Union`:
        return e.recur(As);
    }
  }),
  js = new globalThis.RegExp(`^${wo}$`),
  Ms = new globalThis.RegExp(`^(?:${wo}|Infinity|-Infinity|NaN)$`);
function Ns(e) {
  return ns(js, {
    expected: `a string representing a finite number`,
    representation: { id: `effect/schema/isStringFinite`, payload: null },
    toJsonSchema: () => ({ pattern: js.source }),
    ...e,
  });
}
const Ps = ss(mo, [Ns()]),
  Fs = new V(Ps, Ja),
  Is = new V(new Go([Ps, Jo], `anyOf`), Ja);
function Ls(e, t, n, r, i) {
  for (let a = 0; a < e.length; a++) {
    let o = e[a];
    if (o._tag === `FilterGroup`) {
      if (
        ((n = Ls(o.checks, t, n, r, i)),
        n && (i.errors !== `all` || n[n.length - 1].filter.aborted))
      )
        return n;
    } else {
      let e = o.run(t, r, i);
      if (e) {
        let t = new sa(o, e);
        if ((n ? n.push(t) : (n = [t]), i.errors !== `all` || o.aborted)) return n;
      }
    }
  }
  return n;
}
const Rs = `~effect/SchemaError/SchemaError`;
var zs = class extends Fi(`SchemaError`) {
  [Rs] = Rs;
  constructor(e) {
    super({ issue: e });
  }
  get message() {
    return this.issue.toString();
  }
  toString() {
    return `SchemaError(${this.message})`;
  }
};
const Bs = y((e) => {
  switch (e._tag) {
    case `Declaration`: {
      let t = e.annotations?.[`~effect/Schema/Class`];
      return se(t) ? U(e, [cs(t(e.typeParameters), Bs)]) : e;
    }
    case `Objects`:
    case `Arrays`:
      return e.recur((e) => {
        let t = e.context?.defaultValue;
        if (t) {
          let n = Bs(e);
          return U(n, n.encoding ? [...n.encoding, ...t] : t);
        }
        return Bs(e);
      });
    case `Suspend`:
      return e.recur(Bs);
    default:
      return e;
  }
});
function Vs(e) {
  let t = Js(Bs(Cs(e.ast)));
  return (e, n) =>
    t(
      e,
      n?.disableChecks
        ? n?.parseOptions
          ? { ...n.parseOptions, disableChecks: !0 }
          : { disableChecks: !0 }
        : n?.parseOptions,
    );
}
function Hs(e) {
  let t = Vs(e);
  return (e, n) => {
    let r = Zi(t(e, n));
    return Bi(r)
      ? hn(r.value)
      : (Aa(r.cause, `Option adapter can only return none for schema issues`), mn());
  };
}
function Us(e) {
  let t = Vs(e);
  return (e, n) => {
    let r = Zi(t(e, n));
    if (Bi(r)) return r.value;
    let i = Aa(r.cause, `Constructor adapter can only throw schema issues`);
    throw Error(i.toString(), { cause: i });
  };
}
function Ws(e, t) {
  let n = Js(e.ast);
  return t === void 0 ? n : (e, r) => n(e, Ks(t, r));
}
function Gs(e, t) {
  return Xs(Ws(e, t));
}
const Ks = (e, t) => (t ? { ...e, ...t } : e),
  qs = (e) => (e === R ? F(new pa()) : Ki(e));
function Js(e) {
  let t;
  return (n, r) => {
    let i = (t ??= Qs(e))(n, r ?? ro);
    return i === z ? Ki(n) : P(i) ? (i[k] === R ? qs(R) : i) : $i(i, qs);
  };
}
function Ys(e) {
  return (t, n) => Zi(e(t, n));
}
function Xs(e) {
  let t = Ys(e);
  return (e, n) => {
    let r = t(e, n);
    return Bi(r) ? cn(r.value) : ln(Aa(r.cause, `Result adapter can only return schema issues`));
  };
}
const Zs = new WeakMap();
function Qs(e) {
  let t = Zs.get(e);
  return (t || Zs.set(e, (t = $s(e))), t);
}
function $s(e) {
  let t = e.getParser(Qs),
    n = e.checks,
    r = e.encoding,
    i = e.encodingChecks,
    a = (n ? n[n.length - 1].annotations : e.annotations)?.parseOptions;
  if (!r && !n && !i) return a ? (e, n) => t(e, Ks(n, a)) : t;
  let o,
    s = (r, a) => {
      let o = t(r, a);
      if (i && !a.disableChecks)
        if (P(o)) {
          if (o._tag === `Success`) {
            let t = o === z ? r : o[k];
            if (r !== R && t !== R) {
              let t = Ls(i, r, void 0, e, a);
              t && (o = F(new L(e, t)));
            }
          }
        } else
          o = Ji(o, (t) => {
            if (r !== R && t !== R) {
              let t = Ls(i, r, void 0, e, a);
              if (t) return F(new L(e, t));
            }
            return Ki(t);
          });
      if (n && !a.disableChecks)
        if (P(o)) {
          if (o._tag === `Success`) {
            let t = o === z ? r : o[k];
            if (t === R) return o;
            let i = Ls(n, t, void 0, e, a);
            i && (o = F(new L(e, i)));
          }
        } else
          o = Ji(o, (t) => {
            if (t !== R) {
              let r = Ls(n, t, void 0, e, a);
              if (r) return F(new L(e, r));
            }
            return Ki(t);
          });
      return o;
    };
  return r
    ? (t, n) => {
        a && (n = Ks(n, a));
        let i = (o ??= r.map((e) => Qs(e.to))),
          c = t,
          l = i[i.length - 1](t, n);
        for (let e = r.length - 1; e >= 0; e--) {
          let t = r[e].transformation,
            a;
          if (P(l) && l._tag === `Success`) {
            let e = Na(l === z ? c : l[k]);
            a = t._tag === `Transformation` ? t.decode.run(e, n) : t.decode(ja(e), n);
          } else
            a =
              t._tag === `Transformation`
                ? $i(l, (e) => t.decode.run(Na(e), n))
                : t.decode(Qi(l, Na), n);
          if (((l = P(a) && a._tag === `Success` ? Pa(a[k]) : $i(a, Pa)), e !== 0)) {
            let t = i[e - 1];
            l._tag === `Success`
              ? ((c = l[k]), (l = t(c, n)))
              : (l = $i(l, (e) => {
                  let r = t(e, n);
                  return r === z ? ja(e) : r;
                }));
          }
        }
        if (l._tag === `Success`) {
          let e = l[k],
            t = s(e, n);
          return t === z ? l : t;
        }
        return (
          (l = Xi(l, (t) => qi(() => Pi(t, (t) => new ca(e, t))))),
          $i(l, (e) => {
            let t = s(e, n);
            return t === z ? ja(e) : t;
          })
        );
      }
    : a
      ? (e, t) => s(e, Ks(t, a))
      : s;
}
const ec = `~effect/Schema/Schema`,
  tc = {
    [ec]: ec,
    pipe() {
      return f(this, arguments);
    },
    annotate(e) {
      return this.rebuild(as(this.ast, e));
    },
    annotateKey(e) {
      return this.rebuild(ms(this.ast, e));
    },
    check(...e) {
      return this.rebuild(ss(this.ast, e));
    },
  };
function nc(e, t) {
  function n() {}
  let r = Object.defineProperties(
    Object.setPrototypeOf(n, tc),
    Object.getOwnPropertyDescriptors({ ...t }),
  );
  ((r.ast = e), (r.rebuild = (e) => nc(e, t)));
  let i = Vs(r);
  return ((r.makeEffect = (e, t) => rc(i(e, t))), (r.make = Us(r)), (r.makeOption = Hs(r)), r);
}
function rc(e) {
  return Xi(e, (e) => qi(() => Pi(e, (e) => new zs(e))));
}
const ic = (e) => e;
function ac(e, t) {
  let n = Gs(e, t);
  return (e, t) => fn(n(e, t), (e) => new zs(e));
}
const W = nc,
  oc = ic((e) => W(gs(e.ast), { schema: e })),
  G = ic((e) => oc(_c(e)));
function K(e) {
  let t = W(new fo(e), {
    literal: e,
    transform(n) {
      return t.pipe(vc(K(n), { decode: B(() => n), encode: B(() => e) }));
    },
  });
  return t;
}
const q = W(uo),
  sc = W(oo),
  cc = W(lo),
  J = W(mo),
  lc = W(vo),
  uc = W(yo);
function dc(e, t) {
  return W(e, {
    fields: t,
    mapFields(e, t) {
      let n = e(this.fields);
      return dc(No(n, t?.unsafePreserveChecks ? this.ast.checks : void 0), n);
    },
  });
}
function Y(e) {
  return dc(No(e, void 0), e);
}
function fc(e, t) {
  return W(ys(e.ast, t.ast), { key: e, value: t });
}
function pc(e, t) {
  return W(e, {
    elements: t,
    mapElements(e, t) {
      let n = e(this.elements);
      return pc(Fo(n, t?.unsafePreserveChecks ? this.ast.checks : void 0), n);
    },
  });
}
const mc = ic((e) => W(new bo(!1, [], [e.ast]), { value: e }));
function hc(e, t) {
  return W(e, {
    members: t,
    mapMembers(e, t) {
      let n = e(this.members);
      return hc(Io(n, this.ast.mode, t?.unsafePreserveChecks ? this.ast.checks : void 0), n);
    },
  });
}
function X(e, t) {
  return hc(Io(e, t?.mode ?? `anyOf`, void 0), e);
}
function gc(e) {
  let t = e.map(K);
  return W(Io(t, `anyOf`, void 0), {
    literals: e,
    members: t,
    mapMembers(e) {
      return X(e(this.members));
    },
    pick(e) {
      return gc(e);
    },
    transform(e) {
      return X(t.map((t, n) => t.transform(e[n])));
    },
  });
}
const _c = ic((e) => X([e, cc]));
function vc(e, t) {
  return (n) => W(_s(n.ast, e.ast, t ? Ga(t) : qa()), { from: n, to: e });
}
(globalThis.RegExp,
  globalThis.URL,
  globalThis.File,
  globalThis.FormData,
  globalThis.URLSearchParams,
  globalThis.Uint8Array);
const Z = J,
  yc = X([J, sc]),
  bc = Y({
    off: G(yc),
    minimal: G(yc),
    low: G(yc),
    medium: G(yc),
    high: G(yc),
    xhigh: G(yc),
    max: G(yc),
  }).annotate({ parseOptions: { onExcessProperty: `error` } }),
  xc = Y({ type: K(`image`), data: J, mimeType: J }),
  Sc = Y({
    id: J,
    name: J,
    api: J,
    provider: J,
    baseUrl: J,
    reasoning: uc,
    input: mc(gc([`text`, `image`])),
    cost: Y({ input: lc, output: lc, cacheRead: lc, cacheWrite: lc }),
    contextWindow: lc,
    maxTokens: lc,
    thinkingLevelMap: G(bc),
    featured: G(uc),
    headers: G(fc(J, J)),
    compat: G(q),
  }),
  Cc = Y({ id: G(Z), type: J }),
  wc = X([
    Y({ type: K(`extension_ui_response`), id: J, value: J }),
    Y({ type: K(`extension_ui_response`), id: J, confirmed: uc }),
    Y({ type: K(`extension_ui_response`), id: J, cancelled: K(!0) }),
  ]),
  Tc = X([
    Y({
      id: G(Z),
      type: K(`prompt`),
      message: J,
      images: G(mc(xc)),
      streamingBehavior: G(gc([`steer`, `followUp`])),
    }),
    Y({ id: G(Z), type: gc([`steer`, `follow_up`]), message: J, images: G(mc(xc)) }),
    Y({ id: G(Z), type: gc([`abort`, `get_state`, `get_available_models`]) }),
    Y({ id: G(Z), type: K(`new_session`), parentSession: G(J) }),
    Y({ id: G(Z), type: K(`set_model`), provider: J, modelId: J }),
    Y({
      id: G(Z),
      type: K(`set_thinking_level`),
      level: gc([`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`]),
    }),
    wc,
  ]),
  Ec = Y({
    id: G(Z),
    type: K(`response`),
    command: K(`get_available_models`),
    success: K(!0),
    data: Y({ models: mc(Sc) }),
  }),
  Dc = Y({ id: G(Z), type: K(`response`), command: J, success: K(!0), data: G(q) }),
  Oc = Y({ id: G(Z), type: K(`response`), command: J, success: K(!1), error: J }),
  kc = X([Ec, Oc]),
  Ac = X([Ec, Dc, Oc]),
  jc = X([
    Y({ type: K(`agent_start`) }),
    Y({ type: K(`agent_end`), messages: mc(q) }),
    Y({ type: K(`turn_start`) }),
    Y({ type: K(`turn_end`), message: q, toolResults: mc(q) }),
    Y({ type: K(`message_start`), message: q }),
    Y({ type: K(`message_update`), message: q, assistantMessageEvent: q }),
    Y({ type: K(`message_end`), message: q }),
    Y({ type: K(`tool_execution_start`), toolCallId: J, toolName: J, args: q }),
    Y({ type: K(`tool_execution_update`), toolCallId: J, toolName: J, args: q, partialResult: q }),
    Y({ type: K(`tool_execution_end`), toolCallId: J, toolName: J, result: q, isError: uc }),
    X([
      Y({
        type: K(`extension_ui_request`),
        id: J,
        method: K(`select`),
        title: J,
        options: mc(J),
        timeout: G(lc),
      }),
      Y({
        type: K(`extension_ui_request`),
        id: J,
        method: K(`confirm`),
        title: J,
        message: J,
        timeout: G(lc),
      }),
      Y({
        type: K(`extension_ui_request`),
        id: J,
        method: K(`input`),
        title: J,
        placeholder: G(J),
        timeout: G(lc),
      }),
      Y({ type: K(`extension_ui_request`), id: J, method: K(`editor`), title: J, prefill: G(J) }),
      Y({
        type: K(`extension_ui_request`),
        id: J,
        method: K(`notify`),
        message: J,
        notifyType: G(gc([`info`, `warning`, `error`])),
      }),
      Y({
        type: K(`extension_ui_request`),
        id: J,
        method: K(`setStatus`),
        statusKey: J,
        statusText: G(J),
      }),
      Y({
        type: K(`extension_ui_request`),
        id: J,
        method: K(`setWidget`),
        widgetKey: J,
        widgetLines: G(mc(J)),
        widgetPlacement: G(gc([`aboveEditor`, `belowEditor`])),
      }),
      Y({ type: K(`extension_ui_request`), id: J, method: K(`setTitle`), title: J }),
      Y({ type: K(`extension_ui_request`), id: J, method: K(`set_editor_text`), text: J }),
    ]),
  ]);
var Mc = class extends Error {
  _tag = `PrimeRpcCompatibilityError`;
  envelopeClass;
  constructor(e) {
    (super(`Prime Agent RPC 0.7.2 ${e} is incompatible`), (this.envelopeClass = e));
  }
};
const Nc = (e, t) => {
    let n = ac(e)(t);
    return dn(n) ? n.success : void 0;
  },
  Pc = (e) =>
    [typeof e.value == `string`, typeof e.confirmed == `boolean`, e.cancelled === !0].filter(
      Boolean,
    ).length === 1,
  Fc = (e) => {
    let t = Nc(Cc, e);
    if (!t || !e || typeof e != `object` || Array.isArray(e))
      return { _tag: `malformed`, error: new Mc(`unknown`) };
    let n = e;
    if (t.type === `response`) {
      let t = n.command === `get_available_models` ? Nc(kc, e) : Nc(Ac, e);
      return t ? { _tag: `response`, value: t } : { _tag: `malformed`, error: new Mc(`response`) };
    }
    if (t.type === `extension_ui_response`) {
      let t = Nc(wc, e);
      return t && Pc(n)
        ? { _tag: `command`, value: t }
        : { _tag: `malformed`, error: new Mc(`command`) };
    }
    let r = Nc(Tc, e);
    if (r) return { _tag: `command`, value: r };
    let i = Nc(jc, e);
    if (i) return { _tag: `known-event`, value: i };
    let a = new Set([
        `prompt`,
        `steer`,
        `follow_up`,
        `abort`,
        `get_state`,
        `get_available_models`,
        `new_session`,
        `set_model`,
        `set_thinking_level`,
      ]),
      o = new Set([
        `agent_start`,
        `agent_end`,
        `turn_start`,
        `turn_end`,
        `message_start`,
        `message_update`,
        `message_end`,
        `tool_execution_start`,
        `tool_execution_update`,
        `tool_execution_end`,
        `extension_ui_request`,
      ]);
    return a.has(t.type)
      ? { _tag: `malformed`, error: new Mc(`command`) }
      : o.has(t.type)
        ? { _tag: `malformed`, error: new Mc(`event`) }
        : { _tag: `unknown-event`, type: t.type, value: n };
  };
var Ic = class extends Error {
  _tag = `PrimeRpcClientError`;
  reason;
  details;
  constructor(e, t = {}) {
    (super(`Prime Agent RPC client failed: ${e}`), (this.reason = e), (this.details = t));
  }
};
const Lc = (e, t, n) => {
    if (!Number.isSafeInteger(e) || e < t)
      throw RangeError(`${n} must be a ${t === 0 ? `non-negative` : `positive`} safe integer`);
    return e;
  },
  Rc = () => new Promise((e) => setImmediate(e));
var zc = class {
  #e;
  #t;
  #n;
  #r;
  #i;
  #a;
  #o;
  #s = new Map();
  #c = 0;
  #l = !1;
  #u = 0;
  #d = !1;
  #f = [];
  #p;
  #m = !1;
  #h = 0;
  #g = 0;
  #_ = Promise.resolve();
  #v = !1;
  #y;
  #b = !1;
  #x = null;
  constructor(e, t = {}) {
    if (
      ((this.#e = e),
      (this.#t = t.requestIdPrefix ?? `prime-rpc`),
      !/^[A-Za-z0-9_-]{1,64}$/.test(this.#t))
    )
      throw RangeError(`requestIdPrefix must be 1-64 safe identifier characters`);
    ((this.#n = Lc(t.defaultTimeoutMs ?? 3e4, 1, `defaultTimeoutMs`)),
      (this.#r = Lc(t.maxStderrBytes ?? 16384, 0, `maxStderrBytes`)),
      (this.#i = Lc(t.maxQueuedEvents ?? 256, 1, `maxQueuedEvents`)),
      (this.#a = Lc(t.maxRecordBytes ?? 1048576, 1, `maxRecordBytes`)),
      (this.#o = new u({ maxRecordBytes: this.#a })),
      this.#C(),
      this.#w(),
      e.exited.then(
        (e) => {
          ((this.#b = !0), (this.#x = e), this.#A(`exit`, { code: e }));
        },
        () => {
          ((this.#b = !0), (this.#x = null), this.#A(`exit`, { code: null }));
        },
      ));
  }
  command(e, t = {}) {
    if (this.#l) return Promise.reject(this.#y ?? new Ic(`exit`, { closed: !0 }));
    let n = Lc(t.timeoutMs ?? this.#n, 1, `timeoutMs`),
      r = `${this.#t}-${++this.#c}`,
      i;
    try {
      i = d({ ...e, id: r }, { maxRecordBytes: this.#a });
    } catch {
      return Promise.reject(new Ic(`write`, { id: r, command: e.type, phase: `encode` }));
    }
    return new Promise((a, o) => {
      let s = (t) => this.#O(r, new Ic(t, { id: r, command: e.type })),
        c = () => s(`aborted`),
        l = {
          command: e.type,
          resolve: a,
          reject: o,
          timer: setTimeout(() => s(`timeout`), n),
          signal: t.signal,
          abort: t.signal === void 0 ? void 0 : c,
        };
      if ((this.#s.set(r, l), t.signal?.aborted)) {
        c();
        return;
      }
      (t.signal?.addEventListener(`abort`, c, { once: !0 }), this.#S({ id: r, record: i }));
    });
  }
  events() {
    if (this.#m) throw new Ic(`protocol`, { eventSubscription: !0 });
    this.#m = !0;
    let e = !1,
      t = !1,
      n = () => {
        this.#m = !1;
      };
    return {
      [Symbol.asyncIterator]() {
        return this;
      },
      next: () => {
        if (e) return Promise.resolve({ value: void 0, done: !0 });
        if (t) return Promise.reject(new Ic(`protocol`, { concurrentEventNext: !0 }));
        let r = this.#f.shift();
        return r === void 0
          ? this.#l
            ? (n(), Promise.resolve({ value: void 0, done: !0 }))
            : ((t = !0),
              new Promise((e) => {
                this.#p = (r) => {
                  if (((t = !1), (this.#p = void 0), r === void 0 && this.#f.length > 0)) {
                    e({ value: this.#f.shift(), done: !1 });
                    return;
                  }
                  (r === void 0 && n(),
                    e(r === void 0 ? { value: void 0, done: !0 } : { value: r, done: !1 }));
                };
              }))
          : Promise.resolve({ value: r, done: !1 });
      },
      return: () => {
        e = !0;
        let r = this.#p;
        return (
          (this.#p = void 0),
          (t = !1),
          n(),
          r?.(void 0),
          Promise.resolve({ value: void 0, done: !0 })
        );
      },
    };
  }
  diagnostics() {
    return {
      pendingRequests: this.#s.size,
      closed: this.#l,
      stderrBytes: this.#u,
      stderrTruncated: this.#d,
      droppedEvents: this.#h,
      duplicateResponses: this.#g,
    };
  }
  close() {
    this.#A(`exit`, { code: null, requested: !0 });
  }
  #S(e) {
    this.#_ = this.#_.then(async () => {
      if (!(this.#l || !this.#s.has(e.id)))
        try {
          await this.#e.write(e.record);
        } catch {
          this.#A(`write`, { id: e.id, phase: `transport` });
        }
    });
  }
  async #C() {
    try {
      for await (let e of this.#e.stdout)
        if ((this.#o.push(e, (e) => this.#T(Fc(e))), this.#l)) return;
      (this.#o.finish(),
        await Rc(),
        await Rc(),
        this.#l || this.#A(this.#b ? `exit` : `eof`, this.#b ? { code: this.#x } : {}));
    } catch (e) {
      this.#A(e instanceof c ? `framing` : `eof`, {});
    }
  }
  async #w() {
    try {
      for await (let e of this.#e.stderr) {
        let t = Math.max(0, this.#r - this.#u),
          n = Math.min(e.byteLength, t);
        ((this.#u += n), n !== e.byteLength && (this.#d = !0));
      }
    } catch {
      this.#d = !0;
    }
  }
  #T(e) {
    if (e._tag === `malformed`) {
      this.#A(`protocol`, { envelope: e.error.envelopeClass });
      return;
    }
    if (e._tag !== `response`) {
      this.#E(e);
      return;
    }
    let t = e.value.id;
    if (t === void 0) {
      this.#A(`protocol`, { responseId: !1 });
      return;
    }
    let n = this.#s.get(t);
    if (!n) {
      this.#g += 1;
      return;
    }
    if (n.command !== e.value.command) {
      this.#O(
        t,
        new Ic(`response-command`, { id: t, expected: n.command, actual: e.value.command }),
      );
      return;
    }
    this.#D(t, e.value);
  }
  #E(e) {
    if (this.#l) return;
    let t = this.#p;
    if (t) {
      t(e);
      return;
    }
    (this.#f.length === this.#i && (this.#f.shift(), (this.#h += 1)), this.#f.push(e));
  }
  #D(e, t) {
    let n = this.#s.get(e);
    n && (this.#k(e, n), n.resolve(t));
  }
  #O(e, t) {
    let n = this.#s.get(e);
    n && (this.#k(e, n), n.reject(t));
  }
  #k(e, t) {
    (this.#s.delete(e),
      clearTimeout(t.timer),
      t.signal && t.abort && t.signal.removeEventListener(`abort`, t.abort));
  }
  #A(e, t) {
    if (this.#l) return;
    ((this.#l = !0), (this.#y = new Ic(e, t)));
    for (let [n] of this.#s) this.#O(n, new Ic(e, t));
    let n = this.#p;
    ((this.#p = void 0),
      n?.(void 0),
      this.#v || ((this.#v = !0), Promise.resolve(this.#e.close?.()).catch(() => void 0)));
  }
};
const Bc = (e, t, n = {}) => {
    let r = s(e, [...t], { ...n, stdio: `pipe` }),
      i = !1,
      a = !1,
      o,
      c = new Promise((e) => {
        o = e;
      }),
      l = (e) => {
        a || ((a = !0), r.off(`error`, u), r.off(`exit`, d), r.stdout.off(`end`, f), o(e));
      },
      u = () => l(null),
      d = (e) => l(e),
      f = () => {
        (r.exitCode !== null || r.signalCode !== null) && l(r.exitCode);
      };
    (r.once(`error`, u), r.once(`exit`, d), r.stdout.once(`end`, f));
    let p = () => void 0;
    return (
      r.stdin.on(`error`, p),
      r.stdout.on(`error`, p),
      r.stderr.on(`error`, p),
      {
        stdout: r.stdout,
        stderr: r.stderr,
        exited: c,
        write: (e) =>
          new Promise((t, n) => {
            if (i || r.stdin.destroyed || !r.stdin.writable) {
              n(Error(`Prime RPC stdin is closed`));
              return;
            }
            let a = !1,
              o = (e) => {
                a || ((a = !0), r.stdin.off(`error`, s), e ? n(e) : t());
              },
              s = (e) => o(e);
            r.stdin.once(`error`, s);
            try {
              r.stdin.write(e, (e) => o(e));
            } catch (e) {
              o(e instanceof Error ? e : Error(`Prime RPC write failed`));
            }
          }),
        close: () => {
          i ||
            ((i = !0),
            r.stdin.destroy(),
            r.stdout.destroy(),
            r.stderr.destroy(),
            r.exitCode === null && r.signalCode === null && !r.killed && r.kill());
        },
      }
    );
  },
  Vc = o(new URL(`./fake-prime-agent.mjs`, import.meta.url)),
  Hc = [],
  Q = (e, t) => {
    if (!e) throw Error(t);
    Hc.push(t);
  },
  $ = async (e, t) => {
    try {
      throw (await e, Error(`expected ${t}`));
    } catch (e) {
      Q(e instanceof Ic && e.reason === t, `${t} rejection`);
    }
  };
let Uc = Vc;
const Wc = [],
  Gc = (e, t = {}) => {
    let n = new zc(Bc(process.execPath, [Uc, `--mode`, `rpc`, `--scenario`, e]), {
      requestIdPrefix: e.replaceAll(`-`, `_`),
      defaultTimeoutMs: 1e3,
      ...t,
    });
    return (Wc.push(n), n);
  };
await (async () => {
  let o = await t(a(r(), `pa-m03-artifact-`));
  ((Uc = a(o, i(Vc))), await e(Vc, Uc));
  try {
    let e = Gc(`reverse-two`, { maxQueuedEvents: 1 }),
      t = e.command({ type: `get_state` }),
      n = e.command({ type: `get_state` });
    (Q(
      (await n).id?.endsWith(`-2`) && (await t).id?.endsWith(`-1`),
      `interleaved concurrent correlation`,
    ),
      Q(e.diagnostics().droppedEvents === 1, `unread consumer does not block responses`));
    let r = Gc(`duplicate`);
    (await r.command({ type: `get_state` }),
      await r.command({ type: `abort` }),
      Q(r.diagnostics().duplicateResponses === 1, `duplicate successful id diagnostic`));
    let i = Gc(`mismatch`);
    await $(i.command({ type: `get_state` }), `response-command`);
    let a = Gc(`late-after-abort`),
      o = a.events(),
      s = new AbortController(),
      c = a.command({ type: `get_state` }, { signal: s.signal });
    (Q(!(await o.next()).done, `late request accepted before abort`),
      await o.return?.(),
      s.abort(),
      await $(c, `aborted`),
      await a.command({ type: `abort` }),
      Q(a.diagnostics().duplicateResponses === 1, `late-after-abort exact once`));
    let l = Gc(`timeout`, { defaultTimeoutMs: 1 }),
      u = 0;
    (await $(
      l.command({ type: `get_state` }).catch((e) => {
        throw ((u += 1), e);
      }),
      `timeout`,
    ),
      Q(u === 1, `timeout exact once`));
    let d = Gc(`exit`, { maxStderrBytes: 8 }),
      f = d.command({ type: `get_state` }),
      p = d.command({ type: `abort` });
    (await Promise.all([$(f, `exit`), $(p, `exit`)]),
      Q(
        d.diagnostics().stderrBytes <= 8 && d.diagnostics().stderrTruncated,
        `child exit fanout and bounded redacted stderr`,
      ));
    let m = Gc(`corrupt`);
    await $(m.command({ type: `get_state` }), `framing`);
    let h = Bc(process.execPath, [Uc, `--mode`, `rpc`, `--scenario`, `eof-live`]),
      g = 0,
      _ = new zc({ ...h, close: () => ((g += 1), h.close?.()) }, { requestIdPrefix: `eof` });
    (Wc.push(_),
      await $(_.command({ type: `get_state` }), `eof`),
      _.close(),
      Q(g === 1, `EOF fanout and transport close once`));
    let v = Gc(`write-failure`);
    await new Promise(async (e) => {
      let t = v.events();
      for await (let n of t) n._tag === `unknown-event` && (await t.return?.(), e());
    });
    let y = v.command({ type: `get_state` }),
      ee = v.command({ type: `abort` });
    (await Promise.all([$(y, `write`), $(ee, `write`)]),
      await $(v.command({ type: `get_state` }), `write`),
      Q(v.diagnostics().pendingRequests === 0, `write failure fail-stop`));
    let b = Gc(`events`),
      te = b.events();
    (await b.command({ type: `get_state` }),
      Q(!(await te.next()).done && !(await te.next()).done, `events delivered before close`),
      b.close(),
      Q((await te.next()).done === !0, `event close drain and iterator end`));
    for (let e of Hc) console.log(`PA-M03 ${e}: pass`);
    console.log(`PA-M03 source-derived client/process artifact: pass (${Hc.length} checks)`);
  } finally {
    for (let e of Wc) e.close();
    await n(o, { recursive: !0, force: !0 });
  }
})().catch((e) => {
  (console.error(`PA-M03 artifact: fail: ${e instanceof Error ? e.message : `unknown`}`),
    (process.exitCode = 1));
});
export {};
