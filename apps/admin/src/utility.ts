export const generateRandomId = (): string => {
    return Math.random().toString(36).substring(2, 15);
};

export const toReadableText = (identifier: string): string => {
    /**
     * Converts an identifier (kebab-case, camelCase, or mixed) into a human-readable title.
     *
     * Note: this normalizes whitespace so accessibility labels (and other UI strings)
     * don't end up with duplicated spaces when the source identifier contains them.
     */
    // First split by hyphens if present
    const withoutHyphens = identifier.split('-').join(' ');

    // Then handle camelCase by adding spaces before capital letters
    const withSpaces = withoutHyphens.replace(/([A-Z])/g, ' $1');

    // Clean up any extra spaces and capitalize first letter of each word
    return withSpaces
        .trim()
        .toLowerCase()
        .split(/\s+/)
        .filter((word) => word.length > 0)
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ');
};
