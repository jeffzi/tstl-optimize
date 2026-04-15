function pureUnused()
    local live = 10
    return live
end
function usedLocal()
    local x = 5
    return x * 2
end
function captureExample()
    local base = 100
    return function() return base + 1 end
end
function impureUnused()
    local unused = compute()
    return 0
end
moduleLevel = 99
function multiVar()
    local p, q = swap()
    log(p + q)
end
print(pureUnused())
print(usedLocal())
print(captureExample()())
print(impureUnused())
print(moduleLevel)
multiVar()
