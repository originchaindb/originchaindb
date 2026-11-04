import ts from 'typescript';
import path from 'node:path';

const root = path.resolve(process.argv[2] ?? '.');
const entry = path.join(root, 'src/index.ts');
const config = ts.readConfigFile(path.join(root, 'tsconfig.json'), ts.sys.readFile);
const options = ts.parseJsonConfigFileContent(config.config, ts.sys, root).options;
const program = ts.createProgram([entry], options);
const checker = program.getTypeChecker();
const printer = ts.createPrinter({removeComments:true});
const surface = {};
const print = node => printer.printNode(ts.EmitHint.Unspecified, node, node.getSourceFile()).replace(/\s+/g,' ').trim();
const type = node => checker.typeToString(checker.getTypeAtLocation(node), node, ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope);
const signature = node => {
  const parameters = (node.parameters ?? []).map(p => `${p.dotDotDotToken?'...':''}${p.name.getText()}${p.questionToken || p.initializer?'?':''}:${p.type?print(p.type):type(p)}`).join(',');
  const generic = node.typeParameters?.map(print).join(',') ?? '';
  const returned = node.type ? print(node.type) : checker.getSignatureFromDeclaration(node) ? checker.typeToString(checker.getReturnTypeOfSignature(checker.getSignatureFromDeclaration(node)),node,ts.TypeFormatFlags.NoTruncation) : 'void';
  return `<${generic}>(${parameters}):${returned}`;
};
const module = checker.getSymbolAtLocation(program.getSourceFile(entry));
for (const exported of checker.getExportsOfModule(module)) {
  const symbol = exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
  const name = exported.getName();
  for (const declaration of symbol.getDeclarations() ?? []) {
    if (ts.isClassDeclaration(declaration) || ts.isInterfaceDeclaration(declaration)) {
      surface[name] = (ts.isClassDeclaration(declaration)?'class':'interface') + ' ' + (declaration.typeParameters?.map(print).join(',') ?? '') + ' ' + (declaration.heritageClauses?.map(print).join(' ') ?? '');
      const overloads = {};
      for (const member of declaration.members) {
        if (member.modifiers?.some(m => m.kind === ts.SyntaxKind.PrivateKeyword) || (member.name && ts.isPrivateIdentifier(member.name))) continue;
        const memberName = ts.isConstructorDeclaration(member) ? 'constructor' : member.name?.getText();
        if (!memberName) continue;
        const prefix = name + '.' + (member.modifiers?.some(m=>m.kind===ts.SyntaxKind.StaticKeyword)?'static.':'') + memberName;
        if (ts.isMethodDeclaration(member) || ts.isMethodSignature(member) || ts.isConstructorDeclaration(member) || ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member)) {
          const index = overloads[prefix] ?? 0; overloads[prefix] = index + 1;
          surface[prefix + '#' + index] = signature(member);
          if (ts.isConstructorDeclaration(member)) for (const parameter of member.parameters) {
            if (parameter.modifiers?.some(m => m.kind === ts.SyntaxKind.ReadonlyKeyword || m.kind === ts.SyntaxKind.PublicKeyword) && !parameter.modifiers.some(m => m.kind === ts.SyntaxKind.PrivateKeyword))
              surface[name + '.' + parameter.name.getText()] = (parameter.questionToken?'optional ':'required ') + (parameter.modifiers.some(m=>m.kind===ts.SyntaxKind.ReadonlyKeyword)?'readonly ':'') + (parameter.type?print(parameter.type):type(parameter));
          }
        } else surface[prefix] = (member.questionToken?'optional ':'required ') + (member.modifiers?.some(m=>m.kind===ts.SyntaxKind.ReadonlyKeyword)?'readonly ':'') + (member.type?print(member.type):type(member));
      }
    } else if (ts.isFunctionDeclaration(declaration)) surface[name] = signature(declaration);
    else if (ts.isTypeAliasDeclaration(declaration)) surface[name] = print(declaration.type);
    else surface[name] = type(declaration);
  }
}
console.log(JSON.stringify(surface));
