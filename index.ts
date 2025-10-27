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
): string[] | number[] | null {
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

		if (part.type === "array") {
			// Handle root array or nested array
			if (!current.items) {
				return null;
			}

			// Get the items schema
			current = Array.isArray(current.items)
				? current.items[part.index]
				: current.items;

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

			current = current.properties[part.key];
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
function extractEnum(schema: JSONSchema): string[] | number[] | null {
	if (schema.enum) {
		return schema.enum;
	}

	if (schema.const !== undefined) {
		return [schema.const];
	}

	return null;
}

// ===== TEST CASES =====

console.log("=== Example 1: Simple Enum Field ===");
const schema1 = {
	type: "object",
	properties: {
		country: { type: "string", enum: ["IN", "US", "UK"] },
	},
};
console.log(getEnumOptionsForField(schema1, {}, "country"));
// Expected: ["IN", "US", "UK"]

console.log("\n=== Example 2: Conditional Enum (Dependencies) ===");
const schema2 = {
	type: "object",
	properties: {
		country: { type: "string", enum: ["IN", "US"] },
	},
	dependencies: {
		country: {
			oneOf: [
				{
					properties: {
						country: { const: "IN" },
						state: { type: "string", enum: ["MH", "DL"] },
					},
				},
				{
					properties: {
						country: { const: "US" },
						state: { type: "string", enum: ["CA", "TX"] },
					},
				},
			],
		},
	},
};
console.log(getEnumOptionsForField(schema2, { country: "IN" }, "state"));
// Expected: ["MH", "DL"]
console.log(getEnumOptionsForField(schema2, { country: "US" }, "state"));
// Expected: ["CA", "TX"]

console.log("\n=== Example 3: Nested Object Path ===");
const schema3 = {
	type: "object",
	properties: {
		user: {
			type: "object",
			properties: {
				address: {
					type: "object",
					properties: {
						city: { type: "string", enum: ["Delhi", "Mumbai", "Bangalore"] },
					},
				},
			},
		},
	},
};
console.log(getEnumOptionsForField(schema3, {}, "user.address.city"));
// Expected: ["Delhi", "Mumbai", "Bangalore"]

console.log("\n=== Example 4: Array with Nested Objects ===");
const schema4 = {
	type: "object",
	properties: {
		users: {
			type: "array",
			items: {
				type: "object",
				properties: {
					role: { type: "string", enum: ["Admin", "User", "Viewer"] },
				},
			},
		},
	},
};
console.log(
	getEnumOptionsForField(
		schema4,
		{ users: [{ role: "Admin" }] },
		"users[0].role"
	)
);
// Expected: ["Admin", "User", "Viewer"]

console.log("\n=== Example 5: Conditional with if/then/else ===");
const schema5 = {
	type: "object",
	properties: {
		subscriptionType: { type: "string", enum: ["free", "premium"] },
		plan: { type: "string" },
	},
	allOf: [
		{
			if: { properties: { subscriptionType: { const: "free" } } },
			then: { properties: { plan: { enum: ["basic", "trial"] } } },
			else: { properties: { plan: { enum: ["gold", "platinum"] } } },
		},
	],
};
console.log(
	getEnumOptionsForField(schema5, { subscriptionType: "free" }, "plan")
);
// Expected: ["basic", "trial"]
console.log(
	getEnumOptionsForField(schema5, { subscriptionType: "premium" }, "plan")
);
// Expected: ["gold", "platinum"]

console.log("\n=== Example 6: Root Array with Complex Nested Dependencies ===");
const schema6 = {
	type: "array",
	items: {
		type: "object",
		properties: {
			// Simple field in array item
			category: {
				type: "string",
				enum: ["electronics", "clothing", "food"],
			},
			// Nested object with its own array and dependencies
			details: {
				type: "object",
				properties: {
					subCategory: { type: "string" },
					attributes: {
						type: "array",
						items: {
							type: "object",
							properties: {
								attributeType: {
									type: "string",
									enum: ["color", "size", "material"],
								},
								value: { type: "string" },
							},
							// Conditional dependency within nested array
							allOf: [
								{
									if: {
										properties: { attributeType: { const: "color" } },
									},
									then: {
										properties: {
											value: { enum: ["red", "blue", "green"] },
										},
									},
								},
								{
									if: {
										properties: { attributeType: { const: "size" } },
									},
									then: {
										properties: {
											value: { enum: ["S", "M", "L", "XL"] },
										},
									},
								},
								{
									if: {
										properties: { attributeType: { const: "material" } },
									},
									then: {
										properties: {
											value: { enum: ["cotton", "polyester", "silk"] },
										},
									},
								},
							],
						},
					},
				},
				// Dependency on parent's category field
				allOf: [
					{
						if: {
							properties: {
								// This references the parent's category field
							},
						},
					},
				],
			},
		},
		// Top-level dependency in array item
		dependencies: {
			category: {
				oneOf: [
					{
						properties: {
							category: { const: "electronics" },
							details: {
								properties: {
									subCategory: {
										enum: ["mobile", "laptop", "tablet"],
									},
								},
							},
						},
					},
					{
						properties: {
							category: { const: "clothing" },
							details: {
								properties: {
									subCategory: {
										enum: ["shirts", "pants", "shoes"],
									},
								},
							},
						},
					},
					{
						properties: {
							category: { const: "food" },
							details: {
								properties: {
									subCategory: {
										enum: ["fruits", "vegetables", "dairy"],
									},
								},
							},
						},
					},
				],
			},
		},
	},
};

// Test root array with simple field
console.log("Category options for first item:");
const result1 = getEnumOptionsForField(schema6, [], "[0].category");
console.log(result1);
// Expected: ["electronics", "clothing", "food"]

// Test nested object field with dependency on parent
const formState6a = [{ category: "electronics" }];
console.log("\nSubCategory when category is 'electronics':");
const result2 = getEnumOptionsForField(
	schema6,
	formState6a,
	"[0].details.subCategory"
);
console.log(result2);
console.log("Expected: ['mobile', 'laptop', 'tablet']");

const formState6b = [{ category: "clothing" }];
console.log("\nSubCategory when category is 'clothing':");
const result3 = getEnumOptionsForField(
	schema6,
	formState6b,
	"[0].details.subCategory"
);
console.log(result3);
console.log("Expected: ['shirts', 'pants', 'shoes']");

// Test deeply nested array with conditional deps
const formState6c = [
	{
		category: "electronics",
		details: {
			subCategory: "mobile",
			attributes: [{ attributeType: "color" }],
		},
	},
];
console.log("\nAttribute type in nested array:");
const result4 = getEnumOptionsForField(
	schema6,
	formState6c,
	"[0].details.attributes[0].attributeType"
);
console.log(result4);
console.log("Expected: ['color', 'size', 'material']");

console.log("\nAttribute value when type is 'color':");
const result5 = getEnumOptionsForField(
	schema6,
	formState6c,
	"[0].details.attributes[0].value"
);
console.log(result5);
console.log("Expected: ['red', 'blue', 'green']");

const formState6d = [
	{
		category: "clothing",
		details: {
			subCategory: "shirts",
			attributes: [{ attributeType: "size" }],
		},
	},
];
console.log("\nAttribute value when type is 'size':");
const result6 = getEnumOptionsForField(
	schema6,
	formState6d,
	"[0].details.attributes[0].value"
);
console.log(result6);
console.log("Expected: ['S', 'M', 'L', 'XL']");

// Test multiple items in root array
const formState6e = [{ category: "electronics" }, { category: "food" }];
console.log("\nSubCategory for second item when category is 'food':");
const result7 = getEnumOptionsForField(
	schema6,
	formState6e,
	"[1].details.subCategory"
);
console.log(result7);
console.log("Expected: ['fruits', 'vegetables', 'dairy']");

export { getEnumOptionsForField };
