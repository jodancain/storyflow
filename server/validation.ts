import type { Ontology } from "../shared/types.ts";
import { validateOntology } from "../shared/ontology.ts";
import { Store } from "./store.ts";
import { AppError, ensure } from "./util.ts";

/** Both human and model edits pass the same ownership gate. Model output must also be semantically valid. */
export function validateDraft(
  value: unknown,
  store: Store,
  projectId: string,
  fromModel = false,
): Ontology {
  const issues = validateOntology(value);
  const errors = issues.filter(
    (i) =>
      i.severity === "error" &&
      (fromModel ||
        /^(invalid_|unsupported_schema|collection_limit)/.test(i.code)),
  );
  if (errors.length)
    throw new AppError(
      "本体校验未通过；请修正列出的问题",
      422,
      "ontology_invalid",
      errors,
    );
  const ontology = value as Ontology;
  for (const a of ontology.assets || [])
    if (a.fileId) {
      const f = store.file(a.fileId);
      ensure(
        f.projectId === projectId && f.sha256 === a.sha256,
        "绑定素材不属于此项目或内容哈希不符",
        422,
      );
    }
  return ontology;
}
