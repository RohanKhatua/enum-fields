import { describe, it, expect } from "vitest";
import { getEnumOptionsForField } from "../index";

describe("getEnumOptionsForField - examples", () => {
  it("Example 1: Simple Enum Field", () => {
    const schema1 = {
      type: "object",
      properties: { country: { type: "string", enum: ["IN", "US", "UK"] } },
    };

    expect(getEnumOptionsForField(schema1 as any, {}, "country")).toEqual([
      "IN",
      "US",
      "UK",
    ]);
  });

  it("Example 2: Conditional Enum (Dependencies)", () => {
    const schema2 = {
      type: "object",
      properties: { country: { type: "string", enum: ["IN", "US"] } },
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
    } as any;

    expect(getEnumOptionsForField(schema2, { country: "IN" }, "state")).toEqual([
      "MH",
      "DL",
    ]);
    expect(getEnumOptionsForField(schema2, { country: "US" }, "state")).toEqual([
      "CA",
      "TX",
    ]);
  });

  it("Example 3: Nested Object Path", () => {
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
    } as any;

    expect(getEnumOptionsForField(schema3, {}, "user.address.city")).toEqual([
      "Delhi",
      "Mumbai",
      "Bangalore",
    ]);
  });

  it("Example 4: Array with Nested Objects", () => {
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
    } as any;

    expect(getEnumOptionsForField(schema4, { users: [{ role: "Admin" }] }, "users[0].role")).toEqual([
      "Admin",
      "User",
      "Viewer",
    ]);
  });

  it("Example 5: Conditional with if/then/else", () => {
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
    } as any;

    expect(getEnumOptionsForField(schema5, { subscriptionType: "free" }, "plan")).toEqual([
      "basic",
      "trial",
    ]);
    expect(getEnumOptionsForField(schema5, { subscriptionType: "premium" }, "plan")).toEqual([
      "gold",
      "platinum",
    ]);
  });

  it("Example 6: Root Array with Complex Nested Dependencies", () => {
    const schema6 = {
      type: "array",
      items: {
        type: "object",
        properties: {
          category: { type: "string", enum: ["electronics", "clothing", "food"] },
          details: {
            type: "object",
            properties: {
              subCategory: { type: "string" },
              attributes: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    attributeType: { type: "string", enum: ["color", "size", "material"] },
                    value: { type: "string" },
                  },
                  allOf: [
                    {
                      if: { properties: { attributeType: { const: "color" } } },
                      then: { properties: { value: { enum: ["red", "blue", "green"] } } },
                    },
                    {
                      if: { properties: { attributeType: { const: "size" } } },
                      then: { properties: { value: { enum: ["S", "M", "L", "XL"] } } },
                    },
                    {
                      if: { properties: { attributeType: { const: "material" } } },
                      then: { properties: { value: { enum: ["cotton", "polyester", "silk"] } } },
                    },
                  ],
                },
              },
            },
            allOf: [],
          },
        },
        dependencies: {
          category: {
            oneOf: [
              { properties: { category: { const: "electronics" }, details: { properties: { subCategory: { enum: ["mobile", "laptop", "tablet"] } } } } },
              { properties: { category: { const: "clothing" }, details: { properties: { subCategory: { enum: ["shirts", "pants", "shoes"] } } } } },
              { properties: { category: { const: "food" }, details: { properties: { subCategory: { enum: ["fruits", "vegetables", "dairy"] } } } } },
            ],
          },
        },
      },
    } as any;

    // Category options for first item
    expect(getEnumOptionsForField(schema6 as any, [], "[0].category")).toEqual([
      "electronics",
      "clothing",
      "food",
    ]);

    // SubCategory when category electronics
    const formState6a = [{ category: "electronics" }];
    expect(getEnumOptionsForField(schema6 as any, formState6a, "[0].details.subCategory")).toEqual([
      "mobile",
      "laptop",
      "tablet",
    ]);

    // SubCategory when category clothing
    const formState6b = [{ category: "clothing" }];
    expect(getEnumOptionsForField(schema6 as any, formState6b, "[0].details.subCategory")).toEqual([
      "shirts",
      "pants",
      "shoes",
    ]);

    // Attribute type in nested array
    const formState6c = [
      { category: "electronics", details: { subCategory: "mobile", attributes: [{ attributeType: "color" }] } },
    ];
    expect(getEnumOptionsForField(schema6 as any, formState6c as any, "[0].details.attributes[0].attributeType")).toEqual([
      "color",
      "size",
      "material",
    ]);

    // Attribute value when type is color
    expect(getEnumOptionsForField(schema6 as any, formState6c as any, "[0].details.attributes[0].value")).toEqual([
      "red",
      "blue",
      "green",
    ]);

    // Attribute value when type is size
    const formState6d = [
      { category: "clothing", details: { subCategory: "shirts", attributes: [{ attributeType: "size" }] } },
    ];
    expect(getEnumOptionsForField(schema6 as any, formState6d as any, "[0].details.attributes[0].value")).toEqual([
      "S",
      "M",
      "L",
      "XL",
    ]);

    // SubCategory for second item when category is food
    const formState6e = [{ category: "electronics" }, { category: "food" }];
    expect(getEnumOptionsForField(schema6 as any, formState6e as any, "[1].details.subCategory")).toEqual([
      "fruits",
      "vegetables",
      "dairy",
    ]);
  });
});
