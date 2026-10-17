EXTERNAL questStatus(questId)
VAR met_elder = false

-> start

=== start ===
马婆婆：旅人，你来得正好。翠谷的史莱姆最近躁动得厉害。
~ met_elder = true
{ questStatus("quest:cull_slimes") == "available":
    * [发生了什么？]
        马婆婆：它们从溪边涌出来，已经伤了好几个采药人。
        -> offer
    * [我这就去。]
        -> offer
}
{ questStatus("quest:cull_slimes") == "active":
    * [我还在清理史莱姆。]
        马婆婆：小心些，别让它们围住你。
        -> END
}
{ questStatus("quest:cull_slimes") == "ready_to_turn_in":
    * [（复命）史莱姆已经清理完了。]
        -> turn_in
}
{ questStatus("quest:cull_slimes") == "completed":
    马婆婆：翠谷里的史莱姆，最近安分多了。
}
{ questStatus("quest:den_cull") == "available":
    * [南边那个洞口是什么地方？]
        马婆婆：那是我们谁也不敢进的史莱姆巢穴。
        -> den_offer
}
{ questStatus("quest:den_cull") == "active":
    * [我还在巢穴里清怪。]
        马婆婆：巢穴里的史莱姆比外面大得多，别硬拼。
        -> END
}
{ questStatus("quest:den_cull") == "ready_to_turn_in":
    * [（复命）巢穴里的史莱姆已经清干净了。]
        -> den_turn_in
}
{ questStatus("quest:den_cull") == "completed":
    马婆婆：你把巢穴也平了，这村子往后能睡个好觉。
}

=== offer ===
# quest:offer:quest:cull_slimes
马婆婆：帮我们清理三只史莱姆吧。完成后回来找我，我把旅人短剑给你。
-> END

=== turn_in ===
# quest:turnin:quest:cull_slimes
马婆婆：你真的做到了！这是说好的报酬。
-> END

=== den_offer ===
# quest:offer:quest:den_cull
马婆婆：下到南边的巢穴里，杀掉三只巢穴史莱姆。回来找我，我把草药和盘缠给你。
-> END

=== den_turn_in ===
# quest:turnin:quest:den_cull
马婆婆：巢穴里的黏核我也收下了——那是村里最稀罕的东西。药和铜钱，拿去。
-> END