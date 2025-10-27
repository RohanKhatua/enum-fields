import Ajv from "ajv";

type JSONSchema = {
	type?: string | string[];
	properties?: Record<string, JSONSchema>;
	items?: JSONSchema | JSONSchema[];
	enum?: (string | number)[];
	const?: any;
	oneOf?: JSONSchema[];
	anyOf?: JSONSchema[];
	allOf?: JSONSchema[];
	if?: JSONSchema;
	then?: JSONSchema;
	else?: JSONSchema;
	dependencies?: Record<string, JSONSchema | string[]>;
	$ref?: string;
	[key: string]: any;
};

/**
 * Main function to get enum options for a target field
 */
function getEnumOptionsForField(
	schema: JSONSchema,
	formState: Record<string, any>,
	targetPath: string
): (string | number)[] | null {
	// Navigate to the target field with proper context
	const fieldSchema = navigateToFieldWithContext(schema, targetPath, formState);

	if (!fieldSchema) {
		return null;
	}

	// Extract enum from the field schema
	return extractEnum(fieldSchema);
}

/**
 * Resolves conditional logic (if/then/else, oneOf, anyOf, allOf, dependencies)
 */
function resolveConditionalSchema(
	schema: JSONSchema,
	formState: Record<string, any>
): JSONSchema {
	let resolved = { ...schema };

	// Handle allOf - evaluate and merge all schemas
	if (resolved.allOf) {
		const allOfSchemas = resolved.allOf.map((s) =>
			resolveConditionalSchema(s, formState)
		);
		resolved = mergeSchemas([resolved, ...allOfSchemas]);
		delete resolved.allOf;
	}

	// Handle if/then/else
	if (resolved.if) {
		const conditionMet = evaluateCondition(resolved.if, formState);
		const conditionalSchema = conditionMet ? resolved.then : resolved.else;

		if (conditionalSchema) {
			const resolvedConditional = resolveConditionalSchema(
				conditionalSchema,
				formState
			);
			resolved = mergeSchemas([resolved, resolvedConditional]);
		}

		delete resolved.if;
		delete resolved.then;
		delete resolved.else;
	}

	// Handle oneOf - find the matching branch
	if (resolved.oneOf) {
		const matchingBranch = findMatchingBranch(resolved.oneOf, formState);
		if (matchingBranch) {
			const resolvedBranch = resolveConditionalSchema(
				matchingBranch,
				formState
			);
			resolved = mergeSchemas([resolved, resolvedBranch]);
		}
		delete resolved.oneOf;
	}

	// Handle anyOf - merge all matching branches
	if (resolved.anyOf) {
		const matchingBranches = resolved.anyOf.filter((branch) =>
			evaluateCondition(branch, formState)
		);
		if (matchingBranches.length > 0) {
			const resolvedBranches = matchingBranches.map((b) =>
				resolveConditionalSchema(b, formState)
			);
			resolved = mergeSchemas([resolved, ...resolvedBranches]);
		}
		delete resolved.anyOf;
	}

	// Handle dependencies
	if (resolved.dependencies) {
		for (const [depKey, depValue] of Object.entries(resolved.dependencies)) {
			if (formState[depKey] !== undefined) {
				if (typeof depValue === "object" && !Array.isArray(depValue)) {
					// Schema dependency
					const depSchema = resolveConditionalSchema(
						depValue as JSONSchema,
						formState
					);
					resolved = mergeSchemas([resolved, depSchema]);
				}
			}
		}
		delete resolved.dependencies;
	}

	// DON'T recursively resolve properties here - let navigation handle it
	// This prevents losing context during traversal

	return resolved;
}

/**
 * Evaluates if a condition schema matches the current form state
 */
function evaluateCondition(
	condition: JSONSchema,
	formState: Record<string, any>
): boolean {
	const ajv = new Ajv({ strict: false });

	try {
		const validate = ajv.compile(condition);
		return validate(formState) as boolean;
	} catch (e) {
		return false;
	}
}

/**
 * Finds the matching oneOf branch based on form state
 */
function findMatchingBranch(
	branches: JSONSchema[],
	formState: Record<string, any>
): JSONSchema | null {
	for (const branch of branches) {
		if (evaluateCondition(branch, formState)) {
			return branch;
		}
	}
	return null;
}

/**
 * Merges multiple schemas into one, deeply merging properties
 */
function mergeSchemas(schemas: JSONSchema[]): JSONSchema {
	const merged: JSONSchema = {};

	for (const schema of schemas) {
		for (const [key, value] of Object.entries(schema)) {
			if (key === "properties") {
				// Deep merge properties
				if (!merged.properties) {
					merged.properties = {};
				}
				const valueProps = value as Record<string, JSONSchema>;
				for (const [propKey, propSchema] of Object.entries(valueProps)) {
					if (merged.properties[propKey]) {
						// Merge existing property schema
						merged.properties[propKey] = mergeSchemas([
							merged.properties[propKey],
							propSchema,
						]);
					} else {
						merged.properties[propKey] = propSchema;
					}
				}
			} else if (key === "required" && merged.required) {
				merged.required = [
					...new Set([...merged.required, ...(value as string[])]),
				];
			} else if (key === "enum") {
				// For enum, later schemas override
				merged[key] = value;
			} else if (
				value !== undefined &&
				key !== "if" &&
				key !== "then" &&
				key !== "else" &&
				key !== "oneOf" &&
				key !== "anyOf" &&
				key !== "allOf" &&
				key !== "dependencies"
			) {
				merged[key] = value;
			}
		}
	}

	return merged;
}

/**
 * Navigates to the target field using the path with proper context tracking
 */
function navigateToFieldWithContext(
	schema: JSONSchema,
	targetPath: string,
	formState: Record<string, any>
): JSONSchema | null {
	const pathParts = parsePath(targetPath);
	let current = schema;
	let currentData: any = formState;

	for (let i = 0; i < pathParts.length; i++) {
		const part = pathParts[i];
		if (!part) {
			return null;
		}

		if (part.type === "array") {
			// Handle root array or nested array
			if (!current.items) {
				return null;
			}

			// Get the items schema
			const itemsSchema = current.items as JSONSchema | JSONSchema[];
			current = (
				Array.isArray(itemsSchema)
					? (itemsSchema[part.index] as JSONSchema)
					: (itemsSchema as JSONSchema)
			) as JSONSchema;

			// Update current data context to the specific array item
			if (Array.isArray(currentData)) {
				currentData = currentData[part.index];
			} else {
				currentData = undefined;
			}

			// Resolve conditionals for this array item with its data
			current = resolveConditionalSchema(current, currentData || {});
		} else if (part.type === "property") {
			// First resolve conditionals at current level before navigating
			current = resolveConditionalSchema(current, currentData || {});

			if (!current.properties || !current.properties[part.key]) {
				return null;
			}

			current = current.properties[part.key] as JSONSchema;
			currentData = currentData?.[part.key];
		}
	}

	// Final resolution at the target field level
	current = resolveConditionalSchema(current, currentData || {});

	return current;
}

/**
 * Parses a path string into structured parts
 * Supports: "user.address.city" and "users[0].role"
 */
function parsePath(
	path: string
): Array<{ type: "property" | "array"; key: string; index: number }> {
	const parts: Array<{
		type: "property" | "array";
		key: string;
		index: number;
	}> = [];
	const regex = /([^\.\[\]]+)|\[(\d+)\]/g;
	let match;

	while ((match = regex.exec(path)) !== null) {
		if (match[1]) {
			// Property access
			parts.push({ type: "property", key: match[1], index: -1 });
		} else if (match[2]) {
			// Array index access
			parts.push({ type: "array", key: "", index: parseInt(match[2], 10) });
		}
	}

	return parts;
}

/**
 * Extracts enum values from a field schema
 */
function extractEnum(schema: JSONSchema): (string | number)[] | null {
	if (schema.enum) {
		return schema.enum as (string | number)[];
	}

	if (schema.const !== undefined) {
		return [schema.const] as (string | number)[];
	}

	return null;
}

export { getEnumOptionsForField };
