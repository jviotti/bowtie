import Dialect from "./Dialect";

import dayjs from "dayjs";
import relativeTime from "dayjs/plugin/relativeTime";

dayjs.extend(relativeTime);

/**
 * Parse a report from some JSONL data.
 */
export const fromSerialized = (jsonl: string): ReportData => {
  const lines = jsonl.trim().split(/\r?\n/);
  return parseReportData(
    lines.map((line) => JSON.parse(line) as Record<string, unknown>),
  );
};

/**
 * Metadata about a report which has been run.
 */
export class RunMetadata {
  readonly dialect: Dialect;
  readonly implementations: Map<string, Implementation>;
  readonly bowtieVersion: string;
  readonly started: Date;
  readonly metadata: Record<string, unknown>;

  constructor(
    dialect: Dialect,
    implementations: Map<string, Implementation>,
    bowtieVersion: string,
    started: Date,
    metadata: Record<string, unknown>,
  ) {
    this.dialect = dialect;
    this.implementations = implementations;
    this.bowtieVersion = bowtieVersion;
    this.started = started;
    this.metadata = metadata;
  }

  ago(): string {
    return dayjs(this.started).fromNow();
  }

  static fromRecord(record: Header): RunMetadata {
    const implementations = new Map<string, Implementation>(
      Object.entries(record.implementations).map(([id, info]) => [
        id,
        implementationFromData(info),
      ]),
    );
    return new RunMetadata(
      Dialect.forURI(record.dialect),
      implementations,
      record.bowtie_version,
      new Date(record.started),
      record.metadata,
    );
  }
}

/**
 * Parse a report from some deserialized JSON objects.
 */
export const parseReportData = (
  lines: Record<string, unknown>[],
): ReportData => {
  const runMetadata = RunMetadata.fromRecord(lines[0] as unknown as Header);

  const implementationsResultsMap = new Map<string, ImplementationResults>();
  for (const id of runMetadata.implementations.keys()) {
    implementationsResultsMap.set(id, {
      id,
      cases: new Map(),
      erroredCases: 0,
      skippedTests: 0,
      failedTests: 0,
      erroredTests: 0,
    });
  }

  const caseMap = new Map<number, Case>();
  let didFailFast = false;
  for (const line of lines) {
    if (line.case) {
      caseMap.set(line.seq as number, line.case as Case);
    } else if (line.implementation) {
      const caseData = caseMap.get(line.seq as number)!;
      const implementationResults = implementationsResultsMap.get(
        line.implementation as string,
      )!;
      if (line.caught !== undefined) {
        const context = line.context as Record<string, unknown>;
        const errorMessage: string = (context?.message ??
          context?.stderr) as string;
        implementationResults.erroredCases++;
        implementationResults.erroredTests += caseData.tests.length;
        implementationResults.cases.set(
          line.seq as number,
          new Array<CaseResult>(caseData.tests.length).fill({
            state: "errored",
            message: errorMessage,
          }),
        );
      } else if (line.skipped) {
        implementationResults.skippedTests += caseData.tests.length;
        implementationResults.cases.set(
          line.seq as number,
          new Array<CaseResult>(caseData.tests.length).fill({
            state: "skipped",
            message: line.message as string,
          }),
        );
      } else if (line.implementation) {
        const caseResults: CaseResult[] = (
          line.results as Record<string, unknown>[]
        ).map((res, idx) => {
          if (res.errored) {
            const context = res.context as Record<string, unknown>;
            const errorMessage = context?.message ?? context?.stderr;
            implementationResults.erroredTests++;
            return {
              state: "errored",
              message: errorMessage as string | undefined,
            };
          } else if (res.skipped) {
            implementationResults.skippedTests++;
            return {
              state: "skipped",
              message: res.message as string | undefined,
            };
          } else {
            const successful = res.valid === caseData.tests[idx].valid;
            if (successful) {
              return {
                state: "successful",
                valid: res.valid as boolean | undefined,
              };
            } else {
              implementationResults.failedTests++;
              return {
                state: "failed",
                valid: res.valid as boolean | undefined,
              };
            }
          }
        });
        implementationResults.cases.set(line.seq as number, caseResults);
      } else if (line.did_fail_fast !== undefined) {
        didFailFast = line.did_fail_fast as boolean;
      }
    }
  }

  return {
    runMetadata: runMetadata,
    cases: caseMap,
    implementationsResults: implementationsResultsMap,
    didFailFast: didFailFast,
  };
};

/**
 * Turn raw implementation data into an Implementation.
 *
 * If/when Implementation is a class, this will be its fromRecord.
 */
export const implementationFromData = (
  data: ImplementationData,
): Implementation =>
  ({
    ...data,
    dialects: data.dialects.map((uri) => Dialect.forURI(uri)),
  }) as Implementation;

export const parseImplementationData = (
  loaderData: Record<string, ReportData>,
) => {
  const allImplementations: Record<string, ImplementationDialectCompliance> =
    {};
  const dialectCompliance: Record<string, Record<string, Partial<Totals>>> = {};

  for (const [key, value] of Object.entries(loaderData)) {
    dialectCompliance[key] = calculateImplementationTotal(
      value.implementationsResults,
    );

    for (const [id, val] of value.runMetadata.implementations.entries()) {
      allImplementations[id] = allImplementations[id] || {
        implementation: val,
        dialectCompliance: {},
      };
      allImplementations[id].dialectCompliance[key] =
        dialectCompliance[key][id];
    }
  }

  return allImplementations;
};

const calculateImplementationTotal = (
  implementationsResults: Map<string, ImplementationResults>,
) => {
  const implementationResult: Record<string, Partial<Totals>> = {};

  Array.from(implementationsResults.entries()).forEach(([key, value]) => {
    implementationResult[key] = {
      erroredTests: value.erroredTests,
      skippedTests: value.skippedTests,
      failedTests: value.failedTests,
    };
  });

  return implementationResult;
};

export const calculateTotals = (data: ReportData): Totals => {
  const totalTests = Array.from(data.cases.values()).reduce(
    (prev, curr) => prev + curr.tests.length,
    0,
  );
  return Array.from(data.implementationsResults.values()).reduce(
    (prev, curr) => ({
      totalTests,
      erroredCases: prev.erroredCases + curr.erroredCases,
      skippedTests: prev.skippedTests + curr.skippedTests,
      failedTests: prev.failedTests + curr.failedTests,
      erroredTests: prev.erroredTests + curr.erroredTests,
    }),
    {
      totalTests: totalTests,
      erroredCases: 0,
      skippedTests: 0,
      failedTests: 0,
      erroredTests: 0,
    },
  );
};

export interface ImplementationData extends Omit<Implementation, "dialects"> {
  dialects: string[];
}

interface Header {
  dialect: string;
  bowtie_version: string;
  metadata: Record<string, unknown>;
  implementations: Record<
    string,
    Omit<Implementation, "dialects"> & { dialects: string[] }
  >;
  started: number;
}

export interface Totals {
  totalTests: number;
  erroredCases: number;
  skippedTests: number;
  failedTests: number;
  erroredTests: number;
}

export interface ReportData {
  runMetadata: RunMetadata;
  cases: Map<number, Case>;
  implementationsResults: Map<string, ImplementationResults>;
  didFailFast: boolean;
}

export interface ImplementationResults {
  id: string;
  cases: Map<number, CaseResult[]>;
  erroredCases: number;
  skippedTests: number;
  failedTests: number;
  erroredTests: number;
}

export interface CaseResult {
  state: "successful" | "failed" | "skipped" | "errored";
  valid?: boolean;
  message?: string;
}

export interface Implementation {
  language: string;
  name: string;
  version?: string;
  dialects: Dialect[];
  homepage: string;
  documentation?: string;
  issues: string;
  source: string;
  links?: {
    description?: string;
    url?: string;
    [k: string]: unknown;
  }[];
  os?: string;
  os_version?: string;
  language_version?: string;

  [k: string]: unknown;
}

export interface ImplementationDialectCompliance {
  implementation: Implementation;
  dialectCompliance: Record<string, Partial<Totals>>;
}

export interface Case {
  description: string;
  comment?: string;
  schema: Record<string, unknown> | boolean;
  registry?: Record<string, unknown>;
  tests: [Test, ...Test[]];
}

export interface Test {
  description: string;
  comment?: string;
  instance: unknown;
  valid?: boolean;
}
