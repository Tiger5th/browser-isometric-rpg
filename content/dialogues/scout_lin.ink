EXTERNAL questStatus(questId)
VAR greeted = false

-> start

=== start ===
林斥候：（从树影里走出来，手按在刀柄上）站住。
{ greeted:
    林斥候：又是你。洞口那边别一个人硬闯。
    -> hint
}
{ questStatus("quest:den_cull") == "available":
    * [你认识南边那个洞口？]
        林斥候：认识，也活着从里面爬出来过一次。
        -> hint
}
{ questStatus("quest:den_cull") == "active":
    * [我正准备下去。]
        林斥候：带上草药。里面的东西比外面大得多。
        -> hint
}
{ questStatus("quest:den_cull") == "ready_to_turn_in":
    * [（复命）洞里的史莱姆已经清干净了。]
        林斥候：……你居然真把它清空了。
        -> hint
}
{ questStatus("quest:den_cull") == "completed":
    * [洞口现在安全了？]
        林斥候：至少现在是。
        -> hint
}
    * [没事，路过。]
        林斥候：那快走。别在林子里绕太久。
        -> END
~ greeted = true

=== hint ===
林斥候：沿着南边那条土路一直走，树线断了就是洞口。
林斥候：洞口有股腥味，闻到就退——除非你打算进去。
林斥候：想知道里面是什么，就去问马婆婆，她就在村里。
    * [（点头）多谢提醒。]
        林斥候：去吧。别死在里面。
        -> END
