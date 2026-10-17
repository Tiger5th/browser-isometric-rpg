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
    * [我该走了。]
        马婆婆：路上小心，旅人。
        -> END
}

=== offer ===
# quest:offer:quest:cull_slimes
马婆婆：帮我们清理三只史莱姆吧。完成后回来找我，我把旅人短剑给你。
-> END

=== turn_in ===
# quest:turnin:quest:cull_slimes
马婆婆：你真的做到了！这是说好的报酬。
-> END
