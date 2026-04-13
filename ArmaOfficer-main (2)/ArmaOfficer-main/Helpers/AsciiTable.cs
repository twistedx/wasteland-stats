using System.Text;

namespace ImpulseGaming.ArmaOfficer.Helpers;

public class AsciiTable
{
    public List<TableColumn> Columns { get; } = [];

    public override string ToString()
    {
        var table = new StringBuilder();

        // Determine the maximum length of each column
        var maxColumnLengths = GetMaxColumnLengths();

        // Create the table header
        var header = string.Join("  ", Columns.Select((col, index) => PadRight(col.Header, maxColumnLengths[index])));
        table.AppendLine(header);
        table.AppendLine(new string('=', header.Length));

        // Create the table rows
        for (var i = 0; i < Columns[0].Rows.Count; i++)
        {
            var row = string.Join("  ",
                Columns.Select((col, index) => PadRight(col.Rows[i], maxColumnLengths[index])));
            table.AppendLine(row);
        }

        return table.ToString();
    }

    private int[] GetMaxColumnLengths()
    {
        var columns = Columns.ToArray();
        var maxColumnLengths = new int[columns.Length];

        for (var i = 0; i < columns.Length; i++)
            maxColumnLengths[i] = Math.Max(columns[i].Header.Length, columns[i].Rows.Max(value => value.Length));

        return maxColumnLengths;
    }

    private static string PadRight(string input, int length)
    {
        return input.PadRight(length);
    }
}

public class TableColumn(string header)
{
    public string Header { get; set; } = header;
    public List<string> Rows { get; } = [];
}