function basicMerge()
    return 6
end
function withNil()
    local y
    y = 11
    return y
end
function forwardRef()
    return 2
end
function closureCapture()
    local a = 1
    local function f()
        return a
    end
    return f
end
function impure()
    local b = compute()
    return 1 + b
end
x = 1
y = 2
print(basicMerge())
print(withNil())
print(forwardRef())
print(closureCapture()())
print(impure())
print(x + y)
