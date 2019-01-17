// @flow

const util = require("./util.js"),
  path = require("path"),
  fs = require("fs"),
  globby = require("globby"),
  findDependencies = require("./find-dependencies"),
  typescript = require("typescript"),
  flowParser = require('flow-parser')

function findDependents(globs/*: Array<string>*/, options/*: FindDependentsCommandOptions*/)/*: Object*/{

  let inputFiles /*: Array<string>*/= globby.sync(globs, {'cwd':process.cwd()})
  let result = {}

  for (let inputFile of inputFiles) {
    let dependents = []
    const dirname = (!options.root) ? path.dirname(inputFile) : options.root
    const baseName = path.basename(inputFile)
    const baseNameNoExt = path.basename(inputFile, path.extname(inputFile))
    const absPathInputFile = path.resolve(inputFile)
    const isTS = baseName.endsWith(".ts")
    let hasNoDepentents = true
    let aliasName = ""
    if (options.parent.webpackConfig) {
      aliasName = util.webpackFindAlias(inputFile, options.parent.webpackConfig)
    }

    // initialize result
    result[inputFile] = {
      absolutePath: absPathInputFile,
      files: dependents.length,
      dependents
    }
    
    const entries = globby.sync([
      path.join(dirname, "**", "*.js"),
      path.join(dirname, "**", "*.ts"), 
      "!"+inputFile,
      "!"+path.join(dirname, "**", "*.spec.js"), 
      "!"+path.join(dirname, "**", "*.d.ts"),
      "!"+path.join("node_modules", "**", "*"),
    ])
    
    for (let entry of entries) {
      
      if (options.onlyNotFound && !hasNoDepentents)
        break

      let data /*: string */ = fs.readFileSync(entry, 'utf8')
      
      // Apply a first filter to exclude some files:
      // Don't consider js files where there is no import/require of inputFile
      if ( data.indexOf('require(') == -1 && data.indexOf('import ') == -1 && 
        (data.indexOf(baseName+'\"') == -1 && data.indexOf(baseNameNoExt+'\"') == -1 &&
        data.indexOf(baseName+'\'') == -1 && data.indexOf(baseNameNoExt+'\'') == -1 &&
        data.indexOf(baseName+'\`') == -1 && data.indexOf(baseNameNoExt+'\`') == -1) && 
        (aliasName && (data.indexOf('\"'+aliasName) == -1 &&
        data.indexOf('\''+aliasName) == -1 &&
        data.indexOf('\`'+aliasName) == -1)) ) {
        continue 
      }

      let ast = {}
      let imports = []
      let isEntryTS = false

      if (entry.trim().endsWith(".ts")) {
        isEntryTS = true
        try {
          ast = typescript.createSourceFile(inputFile, data)
        } catch(e) {
          console.log(e)
          continue
        }
        imports = util.typescriptTraverseAST('kind', [typescript.SyntaxKind.VariableDeclaration, typescript.SyntaxKind.ImportDeclaration], ast)
      }
      else {
        try {
          ast = ast = flowParser.parse(data)
        } catch(e) {
          console.log(e)
          continue
        }
        imports = util.flowTraverseAST('type', ['VariableDeclarator', 'ImportDeclaration'], ast)
      }

      for (let imp /*: Object*/ of imports) {
        let dependent = {
          filePath: entry,
          fileAbsolutePath: path.resolve(entry),
          importPath: '',
          importAbsolutePath: '',
          isCircularDependency: null,
          specifiers: []
        }

        if (isEntryTS) {
          if ( util.isRequireStatement(imp, true) ) {
            dependent.importPath = imp.initializer.arguments[0].text
            if (options.parent.specifiers && imp.name) {
              if (imp.name.kind == typescript.SyntaxKind.Identifier) {
                dependent.specifiers.push({
                  name: imp.name.escapedText,
                  alias: '',
                  isDefault: true
                })
              }
              else if (imp.name.kind == typescript.SyntaxKind.ObjectBindingPattern) {
                for (let element /*: Object*/ of imp.name.elements) {
                  dependent.specifiers.push({
                    name: element.name.escapedText,
                    alias: '',
                    isDefault: false
                  })
                }
              }
            }
          }
          else if ( util.isImportStatement(imp, true) ) {
            dependent.importPath = imp.moduleSpecifier.text
            if (options.parent.specifiers && imp.importClause) {
              if (imp.importClause.name) {
                dependent.specifiers.push({
                  name: imp.importClause.name.escapedText,
                  alias: '',
                  isDefault: true
                })
              }
              if (imp.importClause.namedBindings) {
                for (let element /*: Object*/ of imp.importClause.namedBindings.elements) {
                  dependent.specifiers.push({
                    name: (element.propertyName) ? element.propertyName.escapedText : element.name.escapedText,
                    alias: (element.propertyName) ? element.name.escapedText : '',
                    isDefault: false
                  })
                }
              }
            }
          }
        }
        else {
          if ( util.isRequireStatement(imp, false) ) {
            dependent.importPath = imp.init.arguments[0].value
            if (imp.id) {
              if (imp.id.type == 'Identifier') {
                dependent.specifiers.push({
                  name: imp.id.name,
                  alias: '',
                  isDefault: true
                })
              }
              else if (imp.id.type == 'ObjectPattern') {
                for (let property /*: Object*/ of imp.id.properties) {
                  dependent.specifiers.push({
                    name: property.key.name,
                    alias: '',
                    isDefault: false
                  })
                }
              }
            }
          }
          else if ( util.isImportStatement(imp, false) ) {
            dependent.importPath = imp.source.value
            for (let specifier /*: Object*/ of imp.specifiers) {
              dependent.specifiers.push({
                name: (specifier.imported) ? specifier.imported.name : specifier.local.name,
                alias: (specifier.imported && specifier.imported.name != specifier.local.name) ? specifier.local.name : '',
                isDefault: specifier.type == 'ImportDefaultSpecifier'
              })
            }
          }
        }

        if (dependent.importPath) {
          let webpackAliasResolved = {}

          if (options.parent.webpackConfig) {
            webpackAliasResolved = util.webpackAliasResolver(dependent.importPath, options.parent.webpackConfig)
            dependent.importPath = webpackAliasResolved.module
            dependent.importAbsolutePath = webpackAliasResolved.moduleAbsPath
          }

          if (webpackAliasResolved.isWebpackError) 
            continue

          dependent.importAbsolutePath = (!dependent.importAbsolutePath) ? path.resolve(path.join(path.dirname(entry), dependent.importPath)) : dependent.importAbsolutePath

          if (!path.extname(dependent.importAbsolutePath) || !fs.existsSync(dependent.importAbsolutePath)) {
            // if isTS and isEntryTS are true, then the dependent can't be a .js file
            if (isTS && isEntryTS) {
              if ( fs.existsSync( dependent.importAbsolutePath + '.ts' ) ) {
                dependent.importAbsolutePath += '.ts'
              }
            }
            else if (!isTS && isEntryTS && fs.existsSync( dependent.importAbsolutePath + '.ts' )) {
              // if entry is a typescript file, but inputFile is a javascript, then if the entry has: 
              // 
              //    import file from './inputFile' 
              // 
              // without specifying the extension, then the './inputFile' is considered a typescript file (if it exists)
              continue
            }
            else if (!isTS && fs.existsSync(dependent.importAbsolutePath + '.js')) {
              dependent.importAbsolutePath += '.js'
            }
            if (!webpackAliasResolved.keepRelative && !path.extname(dependent.importPath) && fs.existsSync(dependent.importAbsolutePath) )
              dependent.importPath += path.extname(dependent.importAbsolutePath)
          }
        }

        if (dependent.importAbsolutePath == absPathInputFile) {
          if (options.onlyNotFound) {
            hasNoDepentents = false
            break
          }

          if (options.circular || options.onlyCircular) {
            // $Ignore
            dependent.isCircularDependency = isCircularDependency(absPathInputFile, dependent.fileAbsolutePath, options)
          }
          
          if (options.onlyCircular && dependent.isCircularDependency)
            dependents.push(dependent)
          else if (!options.onlyCircular)
            dependents.push(dependent)

          break
        }
      }

    }

    if (options.onlyNotFound && !hasNoDepentents) {
      delete result[inputFile]
      continue
    }

    result[inputFile] = {
      absolutePath: absPathInputFile,
      files: dependents.length,
      dependents
    }
    
  }

  return result
}

function isCircularDependency(mod/*: string */, absolutePath/*: string */, options/*: FindDependentsCommandOptions*/)/*: boolean */ {
  // clone
  let opts = Object.assign({}, options)
  opts.circular = false
  opts.onlyCircular = false
  delete opts.root
  const deps = findDependencies([mod], opts)

  for (let dependency of deps[mod].dependencies) {
    if (dependency.importAbsolutePath == absolutePath) {
      return true
    }
  }

  return false
}

module.exports = findDependents
