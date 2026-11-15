using System;
using System.Text.Json;

namespace ConnectLive.Agent;

internal sealed record ToolBinding(string deviceId, string sessionId, string authorizationId, string controllerId, string peerId)
{
    internal bool Matches(JsonElement root)
    {
        try
        {
            return root.GetProperty("version").GetInt32() == 1 &&
                root.GetProperty("binding").Deserialize<ToolBinding>() == this;
        }
        catch { return false; }
    }
}
