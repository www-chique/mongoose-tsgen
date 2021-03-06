import mongoose from "mongoose";
import flatten, { unflatten } from "flat";
import glob from "glob";
import path from "path";
import mkdirp from "mkdirp";
import * as fs from "fs";
import _ from "lodash";

const MAIN_HEADER = `/* tslint:disable */\n/* eslint-disable */\n\n// ######################################## THIS FILE WAS GENERATED BY MONGOOSE-TSGEN ######################################## //\n\n// NOTE: ANY CHANGES MADE WILL BE OVERWRITTEN ON SUBSEQUENT EXECUTIONS OF MONGOOSE-TSGEN.\n\n`;
const IMPORTS = `import mongoose from "mongoose";\n`;
const MODULE_DECLARATION_HEADER = `declare module "mongoose" {\n\n`;
const MODULE_DECLARATION_FOOTER = "}\n";

let globalFuncTypes: {
  [modelName: string]: {
    methods: { [funcName: string]: string };
    statics: { [funcName: string]: string };
    query: { [funcName: string]: string };
    virtuals: { [virtualName: string]: string };
  };
};

// TODO: this is kinda messy to do
export const setFunctionTypes = (funcTypes: any) => {
  globalFuncTypes = funcTypes;
};

const getSubDocName = (path: string, modelName = "") => {
  let subDocName =
    modelName +
    path
      .split(".")
      .map((p: string) => p[0].toUpperCase() + p.slice(1))
      .join("");

  if (subDocName.endsWith("s")) subDocName = subDocName.slice(0, -1);
  return subDocName;
};

const makeLine = ({
  key,
  val,
  isOptional = false,
  newline = true
}: {
  key: string;
  val: string;
  isOptional?: boolean;
  newline?: boolean;
}) => {
  let line = "";

  if (key) {
    line += key;
    if (isOptional) line += "?";
    line += ": ";
  }
  line += val + ";";
  if (newline) line += "\n";
  return line;
};

const parseFunctions = (
  funcs: any,
  modelName: string,
  funcType: "methods" | "statics" | "query"
) => {
  let interfaceString = "";

  Object.keys(funcs).forEach(key => {
    if (["initializeTimestamps"].includes(key)) return;

    const funcSignature =
      globalFuncTypes?.[modelName]?.[funcType]?.[key] ?? "(...args: any[]) => any";
    const [, params, returnType] =
      funcSignature.match(/\((?:this: \w*(?:, )?)?(.*)\) => (.*)/) ?? [];
    let type;
    if (funcType === "query") {
      key += `<Q extends mongoose.DocumentQuery<any, ${modelName}Document, {}>>(this: Q${
        params?.length > 0 ? ", " + params : ""
      })`;
      // query funcs always must return a query
      type = "Q";
    } else if (funcType === "methods") {
      key += `<D extends ${modelName}Document>(this: D${params?.length > 0 ? ", " + params : ""})`;
      type = returnType ?? "any";
    } else {
      key += `<M extends ${modelName}Model>(this: M${params?.length > 0 ? ", " + params : ""})`;
      type = returnType ?? "any";
    }

    interfaceString += makeLine({ key, val: type });
  });

  return interfaceString;
};

export const parseSchema = ({
  schema,
  modelName,
  addModel = false,
  isDocument,
  header = "",
  footer = "",
  isAugmented = false
}: {
  schema: any;
  modelName?: string;
  addModel?: boolean;
  isDocument: boolean;
  header?: string;
  footer?: string;
  isAugmented?: boolean;
}) => {
  let template = "";

  if (schema.childSchemas?.length > 0 && modelName) {
    const flatSchemaTree: any = flatten(schema.tree, { safe: true });
    let childInterfaces = "";

    const processChild = (rootPath: string) => {
      return (child: any) => {
        const path = child.model.path;
        const isSubdocArray = child.model.$isArraySubdocument;

        const name = getSubDocName(path, rootPath);

        child.schema._isReplacedWithSchema = true;
        child.schema._inferredInterfaceName = name;
        child.schema._isSubdocArray = isSubdocArray;
        flatSchemaTree[path] = isSubdocArray ? [child.schema] : child.schema;

        childInterfaces += parseSchema({
          schema: child.schema,
          modelName: name,
          // we use "mongoose.Types.Embedded" instead of "mongoose.Types.Subdocument" to give us access to additional subdoc functions such as doc.parent()
          header: isDocument ?
            `type ${name}Document = ${
                isSubdocArray ? "mongoose.Types.Embedded" : `mongoose.Document & ${name}Methods`
              } & {\n` :
            `interface ${name} {`,
          isDocument,
          footer: `}${isDocument ? ` & ${name}` : ""}\n\n`,
          isAugmented
        });
      };
    };

    schema.childSchemas.forEach(processChild(modelName));

    const schemaTree = unflatten(flatSchemaTree);
    schema.tree = schemaTree;
    template += childInterfaces;
  }

  if (!isDocument && schema.statics && modelName && addModel) {
    template += `${isAugmented ? "" : "export "}interface ${modelName}Queries {\n`;
    template += parseFunctions(schema.query ?? {}, modelName, "query");
    template += "}\n\n";

    template += `${isAugmented ? "" : "export "}interface ${modelName}Methods {\n`;
    template += parseFunctions(schema.methods, modelName, "methods");
    template += "}\n\n";

    template += `${isAugmented ? "" : "export "}interface ${modelName}Statics {\n`;
    template += parseFunctions(schema.statics, modelName, "statics");
    template += "}\n\n";

    const modelExtend = `mongoose.Model<${modelName}Document, ${modelName}Queries>`;

    template += `${
      isAugmented ? "" : "export "
    }interface ${modelName}Model extends ${modelExtend}, ${modelName}Statics {}\n\n`;
  }

  if (!isAugmented) header = "export " + header;
  template += header;

  const schemaTree = schema.tree;

  const parseKey = (key: string, valOriginal: any): string => {
    // if the value is an object, we need to deepClone it to ensure changes to `val` aren't persisted in parent function
    let val = _.isPlainObject(valOriginal) ? _.cloneDeep(valOriginal) : valOriginal;

    // if type is provided directly on property, expand it
    if (
      [
        String,
        Number,
        Boolean,
        Date,
        mongoose.Schema.Types.ObjectId,
        mongoose.Types.ObjectId
      ].includes(val)
    )
      val = { type: val, required: false };

    let valType;
    let isOptional = !val.required;

    let isArray = Array.isArray(val);
    // this means its a subdoc
    if (isArray) {
      isOptional = false;
      val = val[0];
    } else if (Array.isArray(val.type)) {
      val.type = val.type[0];
      isArray = true;

      /**
       * Arrays can also take the following format.
       * This is used when validation needs to be done on both the element itself and the full array.
       * This format implies `required: true`.
       *
       * ```
       * friends: {
       *   type: [
       *     {
       *       type: Schema.Types.ObjectId,
       *       ref: "User",
       *       validate: [
       *         function(userId: mongoose.Types.ObjectId) { return !this.friends.includes(userId); }
       *       ]
       *     }
       *   ],
       *   validate: [function(val) { return val.length <= 3; } ]
       * }
       * ```
       */
      if (val.type.type) {
        if (val.type.ref) val.ref = val.type.ref;
        val.type = val.type.type;
        isOptional = false;
      }
    }

    if (val._inferredInterfaceName) {
      valType = val._inferredInterfaceName + (isDocument ? "Document" : "");
    }
    // check for virtual properties
    else if (val.path && val.path && val.setters && val.getters) {
      if (key === "id" || !isDocument) {
        return "";
      }

      valType = modelName ? globalFuncTypes?.[modelName]?.virtuals?.[key] ?? "any" : "any";
      isOptional = false;
    } else if (
      key &&
      [
        "get",
        "set",
        "schemaName",
        "defaultOptions",
        "_checkRequired",
        "_cast",
        "checkRequired",
        "cast",
        "__v"
      ].includes(key)
    ) {
      return "";
    } else if (val.ref) {
      let docRef: string;

      docRef = val.ref.replace(`'`, "");
      if (docRef.includes(".")) {
        docRef = getSubDocName(docRef);
      }

      if (isDocument) {
        /**
         * NOTE: when referencing the _id property of a ref, we need to check if modelName === docRef because typescript types dont allow self-referencing a property (only the entire type).
         * The ideal setup would look like this:
         * ```typescript
         * export type UserDocument = mongoose.Document & {
         *   friends: mongoose.Types.Array<UserDocument["_id"] | UserDocument>;
         * } & User
         * ```
         *
         * Unfortunately the `UserDocument["_id"]` piece of the above code gives the error "'friends' is referenced directly or indirectly in its own type annotation.ts(2502)".
         * Instead we need to use `User`, but we can still reference UserDocument for the second half of the union (representing the populated version):
         * ```typescript
         * export type UserDocument = mongoose.Document & {
         *   friends: mongoose.Types.Array<User["_id"] | UserDocument>;
         * } & User
         * ```
         */
        valType = `${docRef}${docRef === modelName ? "" : "Document"}["_id"] | ${docRef}Document`;
      } else {
        valType = `${docRef}["_id"] | ${docRef}`;
      }
    }
    // NOTE: ideally we check actual type of value to ensure its Schema.Types.Mixed (the same way we do with Schema.Types.ObjectId),
    // but this doesnt seem to work for some reason
    else if (val.schemaName === "Mixed" || val.type?.schemaName === "Mixed") {
      if (!isDocument) return "";
      valType = "any";
    } else {
      // if (isArray || !isDocument)
      let typeFound = true;
      switch (val.type) {
        case String:
          if (val.enum?.length > 0) {
            valType = `"` + val.enum.join(`" | "`) + `"`;
          } else valType = "string";
          break;
        case Number:
          if (key !== "__v") valType = "number";
          break;
        case Boolean:
          valType = "boolean";
          break;
        case Date:
          valType = "Date";
          break;
        case mongoose.Schema.Types.ObjectId:
        case mongoose.Types.ObjectId:
          valType = "mongoose.Types.ObjectId";
          break;
        // _id fields have type as a string
        case "ObjectId":
          isOptional = false;
          valType = "mongoose.Types.ObjectId";
          break;
        default:
          typeFound = false;
      }

      if (!typeFound) {
        // if we dont find it, go one level deeper
        // here we pass isAugmented: true to prevent `export ` from being prepended to the header
        valType = parseSchema({
          schema: { tree: val },
          header: "{\n",
          isDocument,
          footer: "}",
          isAugmented: true
        });

        isOptional = false;
      }
      // skip base types for documents
      else if (isDocument) valType = undefined;
    }

    if (!valType) return "";

    if (isArray) {
      if (isDocument)
        valType = `mongoose.Types.${val._isSubdocArray ? "Document" : ""}Array<` + valType + ">";
      else {
        // if valType includes a space, likely means its a union type (ie "number | string") so lets wrap it in brackets when adding the array to the type
        if (valType.includes(" ")) valType = `(${valType})`;
        valType = `${valType}[]`;
      }
    }

    return makeLine({ key, val: valType, isOptional });
  };

  Object.keys(schemaTree).forEach((key: string) => {
    const val = schemaTree[key];
    template += parseKey(key, val);
  });

  template += footer;

  return template;
};

export const registerUserTs = (basePath: string): (() => void) | null => {
  let pathToSearch: string;
  if (basePath.endsWith(".json")) pathToSearch = basePath;
  else pathToSearch = path.join(basePath, "**/tsconfig.json");

  const files = glob.sync(pathToSearch, { ignore: "**/node_modules/**" });

  if (files.length === 0) throw new Error(`No tsconfig.json file found at path "${basePath}"`);
  else if (files.length > 1)
    throw new Error(
      `Multiple tsconfig.json files found. Please specify a more specific --project value.\nPaths found: ${files}`
    );

  const foundPath = path.join(process.cwd(), files[0]);
  require("ts-node").register({ transpileOnly: true, project: foundPath });

  // handle path aliases
  const tsConfig = require(foundPath);
  if (tsConfig?.compilerOptions?.paths) {
    const cleanup = require("tsconfig-paths").register({
      baseUrl: process.cwd(),
      paths: tsConfig.compilerOptions.paths
    });

    return cleanup;
  }

  return null;
};

interface LoadedSchemas {
  [modelName: string]: mongoose.Schema;
}

export const loadSchemas = (modelsPaths: string[]) => {
  const schemas: LoadedSchemas = {};

  const checkAndRegisterModel = (obj: any): boolean => {
    if (!obj?.modelName || !obj?.schema) return false;
    schemas[obj.modelName] = obj.schema;
    return true;
  };

  // we check each file's export object for property names that would commonly export the schema.
  // Here is the priority (using the filename as a starting point to determine model name):
  // default export, model name (ie `User`), model name lowercase (ie `user`), collection name (ie `users`), collection name uppercased (ie `Users`).
  // If none of those exist, we assume the export object is set to the schema directly
  modelsPaths.forEach((singleModelPath: string) => {
    let exportedData;
    try {
      exportedData = require(singleModelPath);
    } catch (err) {
      if (err.message?.includes(`Cannot find module '${singleModelPath}'`))
        throw new Error(`Could not find a module at path ${singleModelPath}.`);
      else throw err;
    }

    // if exported data has a default export, use that
    if (checkAndRegisterModel(exportedData.default) || checkAndRegisterModel(exportedData)) return;

    // if no default export, look for a property matching file name
    const { name: filenameRoot } = path.parse(singleModelPath);

    // capitalize first char
    const modelName = filenameRoot.charAt(0).toUpperCase() + filenameRoot.slice(1);
    const collectionNameUppercased = modelName + "s";

    let modelNameLowercase = filenameRoot.endsWith("s") ? filenameRoot.slice(0, -1) : filenameRoot;
    modelNameLowercase = modelNameLowercase.toLowerCase();

    const collectionName = modelNameLowercase + "s";

    // check likely names that schema would be exported from
    if (
      checkAndRegisterModel(exportedData[modelName]) ||
      checkAndRegisterModel(exportedData[modelNameLowercase]) ||
      checkAndRegisterModel(exportedData[collectionName]) ||
      checkAndRegisterModel(exportedData[collectionNameUppercased])
    )
      return;

    // if none of those have it, check all properties
    for (const obj of Object.values(exportedData)) {
      if (checkAndRegisterModel(obj)) return;
    }

    throw new Error(
      `A module was found at ${singleModelPath}, but no exported models were found. Please ensure this file exports a Mongoose Model (preferably default export).`
    );
  });

  return schemas;
};

export const generateFileString = ({
  schemas,
  isAugmented,
  imports = []
}: {
  schemas: LoadedSchemas;
  isAugmented: boolean;
  imports?: string[];
}) => {
  let fullTemplate = MAIN_HEADER;

  // default imports
  fullTemplate += IMPORTS;

  // custom, user-defined imports
  fullTemplate += imports.join("\n") + "\n";

  if (isAugmented) fullTemplate += MODULE_DECLARATION_HEADER;

  Object.keys(schemas).forEach(modelName => {
    const schema = schemas[modelName];
    let interfaceStr = "";

    // passing modelName causes childSchemas to be processed
    interfaceStr += parseSchema({
      schema,
      modelName,
      addModel: true,
      isDocument: false,
      header: `interface ${modelName} {\n`,
      footer: "}\n\n",
      isAugmented
    });

    interfaceStr += parseSchema({
      schema,
      modelName,
      addModel: true,
      isDocument: true,
      header: `type ${modelName}Document = mongoose.Document & ${modelName}Methods & {\n`,
      footer: `} & ${modelName}\n\n`,
      isAugmented
    });

    fullTemplate += interfaceStr;
  });

  if (isAugmented) fullTemplate += MODULE_DECLARATION_FOOTER;

  return fullTemplate;
};

export const writeOrCreateInterfaceFiles = ({
  interfaceString,
  genFilePath
}: {
  interfaceString: string;
  genFilePath: string;
}) => {
  try {
    fs.writeFileSync(genFilePath, interfaceString, "utf8");
  } catch (err) {
    // if folder doesnt exist, create and then write again
    if (err.message.includes("ENOENT: no such file or directory")) {
      console.log(`Path ${genFilePath} not found; creating...`);

      const { dir } = path.parse(genFilePath);
      mkdirp.sync(dir);

      fs.writeFileSync(genFilePath, interfaceString, "utf8");
    }
  }
};
