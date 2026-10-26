import { describe, expect, it } from "vitest";
import {
  ALIAS_MAP,
  resolveSideEffectType,
  SIDE_EFFECT_TYPES,
  TIER_MAP,
} from "../src/taxonomy.js";

// Tier membership transcribed verbatim from the authoritative table in
// specs/001-discovery-shared-analysis/data-model.md (Gaze protocol v1.2.0).
// Deliberately plain string data, NOT the source types: this suite conforms
// the implementation to the spec tables, so it must not share their shapes.
const PINNED_TIER_MEMBERS: Readonly<Record<string, readonly string[]>> = {
  P0: [
    "ReturnValue",
    "ErrorReturn",
    "SentinelError",
    "ReceiverMutation",
    "PointerArgMutation",
    "ErrorSignal",
  ],
  P1: [
    "SliceMutation",
    "MapMutation",
    "GlobalMutation",
    "WriterOutput",
    "HTTPResponseWrite",
    "ChannelSend",
    "ChannelClose",
    "DeferredReturnMutation",
    "GeneratorYield",
    "ContainerMutation",
    "StreamOutput",
  ],
  P2: [
    "FileSystemWrite",
    "FileSystemDelete",
    "FileSystemMeta",
    "DatabaseWrite",
    "DatabaseTransaction",
    "GoroutineSpawn",
    "Panic",
    "CallbackInvocation",
    "LogWrite",
    "ContextCancellation",
    "AsyncGeneratorYield",
    "MetaprogrammingMutation",
    "DescriptorEffect",
    "ResourceManagement",
    "ImportSideEffect",
    "MonkeyPatch",
  ],
  P3: [
    "StdoutWrite",
    "StderrWrite",
    "EnvVarMutation",
    "MutexOp",
    "WaitGroupOp",
    "AtomicOp",
    "TimeDependency",
    "ProcessExit",
    "RecoverBehavior",
  ],
  P4: [
    "ReflectionMutation",
    "UnsafeMutation",
    "CgoCall",
    "FinalizerRegistration",
    "SyncPoolOp",
    "ClosureCaptureMutation",
  ],
};

// The 11 alias resolutions transcribed verbatim from the data-model.md
// alias table (FR-012).
const PINNED_ALIASES: Readonly<Record<string, string>> = {
  AsyncTaskSpawn: "GoroutineSpawn",
  AsyncMessageSend: "ChannelSend",
  AsyncChannelClose: "ChannelClose",
  BarrierOp: "WaitGroupOp",
  PanicRecovery: "RecoverBehavior",
  FFICall: "CgoCall",
  ObjectPoolOp: "SyncPoolOp",
  DeferredMutation: "DeferredReturnMutation",
  ArgumentMutation: "PointerArgMutation",
  ProcessTermination: "Panic",
  SentinelErrorDecl: "SentinelError",
};

const TIER_STRINGS: readonly string[] = ["P0", "P1", "P2", "P3", "P4"];

const CANONICAL_NAMES: ReadonlySet<string> = new Set(SIDE_EFFECT_TYPES);

// Own-key tier inversion of TIER_MAP. Object.entries reads own enumerable
// properties only, so Object.prototype names can never leak in.
function membersAssignedTo(tier: string): Set<string> {
  return new Set(
    Object.entries(TIER_MAP)
      .filter(([, value]) => value === tier)
      .map(([type]) => type),
  );
}

describe("SIDE_EFFECT_TYPES", () => {
  it("contains exactly 48 unique members", () => {
    expect(SIDE_EFFECT_TYPES).toHaveLength(48);
    expect(CANONICAL_NAMES.size).toBe(48);
  });

  it("contains no alias names", () => {
    for (const alias of Object.keys(ALIAS_MAP)) {
      expect(CANONICAL_NAMES.has(alias)).toBe(false);
    }
  });
});

describe("TIER_MAP", () => {
  it("assigns every canonical type exactly one tier", () => {
    expect(Object.keys(TIER_MAP).sort()).toEqual([...CANONICAL_NAMES].sort());
  });

  it("uses only the five tier strings as values", () => {
    for (const tier of Object.values(TIER_MAP)) {
      expect(TIER_STRINGS).toContain(tier);
    }
  });

  it("pins the tier sizes at P0=6, P1=11, P2=16, P3=9, P4=6", () => {
    expect(membersAssignedTo("P0").size).toBe(6);
    expect(membersAssignedTo("P1").size).toBe(11);
    expect(membersAssignedTo("P2").size).toBe(16);
    expect(membersAssignedTo("P3").size).toBe(9);
    expect(membersAssignedTo("P4").size).toBe(6);
  });

  it.each([...TIER_STRINGS])(
    "matches the data-model.md %s membership verbatim",
    (tier) => {
      expect(membersAssignedTo(tier)).toEqual(new Set(PINNED_TIER_MEMBERS[tier]));
    },
  );
});

describe("ALIAS_MAP", () => {
  it("maps exactly 11 aliases", () => {
    expect(Object.keys(ALIAS_MAP)).toHaveLength(11);
  });

  it("resolves each alias per the data-model.md alias table", () => {
    expect(Object.keys(ALIAS_MAP).sort()).toEqual(Object.keys(PINNED_ALIASES).sort());
    for (const [alias, target] of Object.entries<string>(ALIAS_MAP)) {
      expect(target).toBe(PINNED_ALIASES[alias]);
    }
  });

  it("targets only canonical members", () => {
    for (const target of Object.values<string>(ALIAS_MAP)) {
      expect(CANONICAL_NAMES.has(target)).toBe(true);
    }
  });
});

describe("resolveSideEffectType", () => {
  it("maps every canonical name to itself", () => {
    for (const type of SIDE_EFFECT_TYPES) {
      const resolved: string | undefined = resolveSideEffectType(type);
      expect(resolved).toBe(type);
    }
  });

  it("maps every alias to its canonical target", () => {
    for (const [alias, target] of Object.entries<string>(ALIAS_MAP)) {
      const resolved: string | undefined = resolveSideEffectType(alias);
      expect(resolved).toBe(target);
    }
  });

  it("maps any other string to undefined", () => {
    const unknownNames = [
      "",
      "toString",
      "constructor",
      "hasOwnProperty",
      "valueOf",
      "__proto__",
      "propertyIsEnumerable",
      "isPrototypeOf",
      "toLocaleString",
      "returnvalue",
      "RETURNVALUE",
      "ReturnValue ",
      " GoroutineSpawn",
      "GoroutineSpawns",
      "P0",
      "P5",
      "some-random-effect",
      "fs.writeFile",
    ];
    for (const name of unknownNames) {
      expect(resolveSideEffectType(name)).toBeUndefined();
    }
  });
});
