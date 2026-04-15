local ____debug_traceback = debug.traceback
traceback = ____debug_traceback()
function getInfo()
    return ____debug_traceback()
end
