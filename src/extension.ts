import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext) {
    console.log('python-role-lens running with strict native-field isolation!');

    // --- HELPER: EXTRACT THE EXACT STRING BLOCK OF A CLASS BODY ---
    function getClassBodySnippet(fullText: string, className: string): { text: string; startOffset: number } | null {
        const classRegex = new RegExp(`class\\s+${className}\\b(?:\\s*\\([^:]*\\))?\\s*:`, 'g');
        const match = classRegex.exec(fullText);
        if (!match) return null;

        const startIdx = match.index;
        const lines = fullText.substring(startIdx).split('\n');
        const bodyLines: string[] = [lines[0]];

        for (let i = 1; i < lines.length; i++) {
            const line = lines[i];
            if (line.trim().length > 0 && !line.startsWith(' ') && !line.startsWith('\t')) {
                break;
            }
            bodyLines.push(line);
        }

        return { text: bodyLines.join('\n'), startOffset: startIdx };
    }

    interface DiscoveredAttribute {
        name: string;
        sourceClass: string;
    }

    // --- HELPER: RECURSIVELY SCRAPE ATTRIBUTES ---
    async function getAllAttributesFromChain(className: string, currentDocument: vscode.TextDocument, isRoot = true): Promise<DiscoveredAttribute[]> {
        let attributes: DiscoveredAttribute[] = [];
        const fullText = currentDocument.getText();
        
        const classBlock = getClassBodySnippet(fullText, className);
        if (classBlock) {
            const lines = classBlock.text.split('\n');
            for (const line of lines) {
                let attrName: string | null = null;
                const fieldMatch = line.match(/^\s+([a-zA-Z0-9_]+)\s*:/);
                if (fieldMatch) attrName = fieldMatch[1];

                const methodMatch = line.match(/^\s+def\s+([a-zA-Z0-9_]+)\s*\(/);
                if (methodMatch && methodMatch[1] !== '__init__') attrName = methodMatch[1];

                if (isRoot) continue;

                if (attrName && !attributes.some(a => a.name === attrName)) {
                    attributes.push({ name: attrName, sourceClass: className });
                }
            }
        }

        const baseClassRegex = new RegExp(`class\\s+${className}\\s*\\(\\s*Role\\s*\\[\\s*([a-zA-Z0-9_]+)\\s*\\]\\s*\\)`);
        const baseMatch = fullText.match(baseClassRegex);
        if (baseMatch) {
            const nextNestedClass = baseMatch[1];
            const deeperAttributes = await getAllAttributesFromChain(nextNestedClass, currentDocument, false);
            deeperAttributes.forEach(attr => {
                if (!attributes.some(a => a.name === attr.name)) {
                    attributes.push(attr);
                }
            });
        }
        return attributes;
    }

    // --- HELPER: LOCATE EXACT CLASS THAT DEFINES AN ATTRIBUTE ---
    async function findOriginClassForAttribute(className: string, attributeName: string, currentDocument: vscode.TextDocument): Promise<string | null> {
        const fullText = currentDocument.getText();
        const classBlock = getClassBodySnippet(fullText, className);
        
        if (classBlock) {
            const attrRegex = new RegExp(`(\\b${attributeName}\\b\\s*:)|(\\bdef\\s+${attributeName}\\b)`);
            if (attrRegex.test(classBlock.text)) {
                return className; 
            }
        }

        const baseClassRegex = new RegExp(`class\\s+${className}\\s*\\(\\s*Role\\s*\\[\\s*([a-zA-Z0-9_]+)\\s*\\]\\s*\\)`);
        const baseMatch = fullText.match(baseClassRegex);
        if (baseMatch) {
            return findOriginClassForAttribute(baseMatch[1], attributeName, currentDocument);
        }
        return null;
    }

    function getDirectClassName(hoverText: string): string | null {
        const classTypeMatch = hoverText.match(/:\s*([a-zA-Z0-9_]+)/);
        return classTypeMatch ? classTypeMatch[1] : null;
    }

    // --- 1. CLEAN AUTOCOMPLETE PROVIDER ---
    const completionProvider = vscode.languages.registerCompletionItemProvider(
        { scheme: 'file', language: 'python' },
        {
            async provideCompletionItems(document: vscode.TextDocument, position: vscode.Position) {
                const lineText = document.lineAt(position.line).text.substring(0, position.character);
                if (!lineText.endsWith('.')) return undefined;

                const matches = lineText.match(/([a-zA-Z0-9_]+)\.$/);
                if (!matches) return undefined;

                const hoverResult: any = await vscode.commands.executeCommand('vscode.executeHoverProvider', document.uri, position.translate(0, -2));
                const hoverText = hoverResult?.[0]?.contents?.[0]?.value || '';
                const directClassName = getDirectClassName(hoverText);

                if (directClassName) {
                    const discoveredFields = await getAllAttributesFromChain(directClassName, document, true);
                    const completionItems = discoveredFields.map(attr => {
                        const item = new vscode.CompletionItem(attr.name, vscode.CompletionItemKind.Field);
                        item.detail = `✨ Delegated from ${attr.sourceClass}`;
                        item.sortText = `00_${attr.name}`; 
                        return item;
                    });
                    return new vscode.CompletionList(completionItems, false);
                }
                return undefined;
            }
        },
        '.'
    );

    // --- 2. DETERMINISTIC DEFINITION PROVIDER ---
    const definitionProvider = vscode.languages.registerDefinitionProvider(
        { scheme: 'file', language: 'python' },
        {
            async provideDefinition(document: vscode.TextDocument, position: vscode.Position) {
                const wordRange = document.getWordRangeAtPosition(position);
                if (!wordRange) return null;
                
                const attributeName = document.getText(wordRange);
                const lineText = document.lineAt(position.line).text;
                
                const varMatch = lineText.match(new RegExp(`([a-zA-Z0-9_]+)\\.${attributeName}`));
                if (!varMatch) return null;
                const varName = varMatch[1];

                const varPosition = new vscode.Position(position.line, lineText.indexOf(varName));
                const hoverResult: any = await vscode.commands.executeCommand('vscode.executeHoverProvider', document.uri, varPosition);
                const hoverText = hoverResult?.[0]?.contents?.[0]?.value || '';
                
                const directClassName = getDirectClassName(hoverText);
                if (!directClassName) return null;

                const fullText = document.getText();

                // 🛑 THE ULTIMATE SHIELD: Check if the attribute is native to this exact class block
                const directClassBlock = getClassBodySnippet(fullText, directClassName);
                if (directClassBlock) {
                    const directAttrRegex = new RegExp(`(\\b${attributeName}\\b\\s*:)|(\\bdef\\s+${attributeName}\\b)`);
                    if (directAttrRegex.test(directClassBlock.text)) {
                        // It is a native property (like subject). Return null immediately!
                        // Pylance handles this natively. You will see EXACTLY 1 definition.
                        return null; 
                    }
                }

                // If we get here, it is a delegated property (like name or company).
                const trueOriginClass = await findOriginClassForAttribute(directClassName, attributeName, document);
                if (!trueOriginClass) return null;

                const classBlock = getClassBodySnippet(fullText, trueOriginClass);
                if (classBlock) {
                    const attrRegex = new RegExp(`(\\b${attributeName}\\b\\s*:)|(\\bdef\\s+${attributeName}\\b)`);
                    const attrMatch = attrRegex.exec(classBlock.text);

                    if (attrMatch) {
                        const absoluteTargetIndex = classBlock.startOffset + attrMatch.index;
                        const targetPosition = document.positionAt(absoluteTargetIndex);

                        const link: vscode.LocationLink = {
                            originSelectionRange: wordRange,
                            targetUri: document.uri,
                            targetRange: new vscode.Range(targetPosition, targetPosition),
                            targetSelectionRange: new vscode.Range(targetPosition, targetPosition)
                        };
                        return [link] as any;
                    }
                }
                return null;
            }
        }
    );

    context.subscriptions.push(completionProvider, definitionProvider);
}

export function deactivate() {}