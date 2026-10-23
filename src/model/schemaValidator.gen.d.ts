// scripts/gen-validator.mjs が生成する検証関数の型 (validateModelSchema と、種類ごとの validate_<kind>)
import type { ErrorObject } from "ajv";

type Validator = ((data: unknown) => boolean) & { errors?: ErrorObject[] | null };

export const validateModelSchema: Validator;
export const validate_actor: Validator;
