using System.Text;

namespace ImpulseGaming.ArmaOfficer.Extensions;

public static class EscapeStringExtension
{
    // Escapes special characters used in markdown syntax.
    public static string EscapeMarkdown(this string input)
    {
        if (string.IsNullOrEmpty(input)) return input;

        // List of characters that need to be escaped in Markdown
        char[] markdownChars = ['\\', '`', '*', '_', '{', '}', '[', ']', '(', ')', '#', '+', '-', '.', '!'];

        var escapedString = new StringBuilder(input.Length);


        foreach (var ch in input)
        {
            if (Array.Exists(markdownChars, c => c == ch)) escapedString.Append('\\');
            escapedString.Append(ch);
        }

        return escapedString.ToString();
    }
}