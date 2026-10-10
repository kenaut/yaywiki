document.addEventListener('DOMContentLoaded', () => {
    const mdContainer = document.getElementById('md-render-target');
    const navList = document.getElementById('sidebar-nav');

    // ===== 搜索跳转相关 DOM =====
    const searchInput = document.getElementById('wiki-search-input');
    const searchResults = document.getElementById('wiki-search-results');

    // 所有页面的扁平索引：{ title, path, breadcrumb(父级分类名), linkEl }
    let pagesIndex = [];
    // 全文索引（首次聚焦搜索框时懒加载，避免拖慢页面初始打开速度）
    let contentIndex = null;
    let contentIndexPromise = null;
    // 当前搜索结果与键盘高亮项
    let currentResults = [];
    let selectedIndex = -1;

    // 1. 启动：先获取我们之前手写好的目录树 JSON
    fetch('./sidebar-tree.json')
        .then(response => {
            if (!response.ok) throw new Error("无法加载目录配置文件");
            return response.json();
        })
        .then(treeData => {
            renderSidebarTree(treeData, navList); // 渲染左侧菜单（传入数据与父容器）
            initSearch();                        // 初始化搜索跳转

            // 默认加载第一篇文章 (这里假设第一层有文件，或者你可以按需修改)
            if (treeData.length > 0 && treeData[0].path) {
                loadMarkdown(treeData[0].path);
            }
        })
        .catch(err => {
            mdContainer.innerHTML = `<p style="color:red">初始化失败: ${err.message}</p>`;
        });

    // 2. 渲染左侧导航树 (支持无限极嵌套)
    function renderSidebarTree(data, parentElement, breadcrumb = []) {
        data.forEach(item => {
            const li = document.createElement('li');
            
            // 🔹 如果有 children，说明它是父级分类（文件夹）
            if (item.children && item.children.length > 0) {
                const a = document.createElement('a');
                a.href = '#';
                a.textContent = item.title;
                a.classList.add('folder-title'); // 加个类名方便写CSS样式
                
                // 点击父级时，切换子菜单的显示/隐藏
                a.addEventListener('click', (e) => {
                    e.preventDefault();
                    const subMenu = li.querySelector('.sub-menu');
                    if (subMenu) subMenu.classList.toggle('open');
                    a.classList.toggle('expanded');
                });

                li.appendChild(a);
                
                // 创建子菜单容器，并【递归调用自己】，把子节点渲染进去
                const ul = document.createElement('ul');
                ul.className = 'sub-menu';
                renderSidebarTree(item.children, ul, [...breadcrumb, item.title]); 
                
                li.appendChild(ul);
            } 
            // 🔹 如果没有 children，说明它是具体的 MD 文件
            else {
                const displayTitle = item.title.replace('.md', ''); // 去掉后缀显示
                const a = document.createElement('a');
                a.href = '#';
                a.textContent = displayTitle;
                a.dataset.path = item.path;

                // 点击事件：加载对应的 MD 文件
                a.addEventListener('click', (e) => {
                    e.preventDefault();
                    loadMarkdown(item.path);
                    
                    // 切换高亮状态
                    navList.querySelectorAll('a').forEach(link => link.classList.remove('active'));
                    a.classList.add('active');
                });

                li.appendChild(a);

                // 收入扁平索引，供搜索使用
                pagesIndex.push({
                    title: displayTitle,
                    path: item.path,
                    breadcrumb: breadcrumb.slice(),
                    linkEl: a
                });
            }
            
            parentElement.appendChild(li);
        });
    }

    // 3. 核心：加载并渲染 Markdown 内容
    function loadMarkdown(filePath) {
        mdContainer.innerHTML = '<p>加载中...</p>';
        
        fetch(filePath)
            .then(res => {
                if (!res.ok) throw new Error("无法加载文件: " + filePath);
                return res.text();
            })
            .then(mdText => {
                mdContainer.innerHTML = marked.parse(mdText);
                setupScrollSpy(); // 重新绑定右侧滚动高亮
            })
            .catch(err => {
                mdContainer.innerHTML = `<p style="color:red">${err.message}</p>`;
            });
    }

    // 4. 滚动自动高亮（完美复用你之前的优秀逻辑）
    function setupScrollSpy() {
        // 每次加载新文章，都要移除旧的监听器防止内存泄漏
        window.removeEventListener('scroll', window.scrollSpyHandler); 

        const links = navList.querySelectorAll('a');
        const sections = [];

        links.forEach(link => {
            const targetId = link.getAttribute('href').substring(1);
            const targetEl = document.getElementById(targetId);
            if (targetEl) sections.push({ el: targetEl, link: link });
        });

        const handleScroll = () => {
            // 目录链接均为页面切换（href="#"），没有真实的页内章节锚点时，
            // 不要清除点击/搜索跳转设置的高亮状态
            if (sections.length === 0) return;

            let current = '';
            const scrollY = window.scrollY;

            sections.forEach(section => {
                if (scrollY >= section.el.offsetTop - 100) {
                    current = section.link.getAttribute('href');
                }
            });

            links.forEach(link => {
                link.classList.remove('active');
                if (link.getAttribute('href') === current) {
                    link.classList.add('active');
                    link.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                }
            });
        };

        window.scrollSpyHandler = handleScroll;
        window.addEventListener('scroll', handleScroll);
        
        // 触发一次，确保刚进来时高亮是对的
        handleScroll(); 
    }

    // =========================================================
    // 5. 搜索跳转
    // =========================================================

    function initSearch() {
        // 输入即搜（标题结果即时出现，全文结果在索引就绪后自动补充）
        searchInput.addEventListener('input', () => {
            ensureContentIndex(); // 首次输入即懒加载全文索引（幂等，只加载一次）
            performSearch(searchInput.value);
        });

        // 聚焦时也预热全文索引，让后续输入能直接出正文结果
        searchInput.addEventListener('focus', () => {
            ensureContentIndex();
            if (currentResults.length > 0) showResults();
        });

        // 键盘操作：↑↓ 选择，Enter 跳转，Esc 清空
        searchInput.addEventListener('keydown', (e) => {
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                moveSelection(1);
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                moveSelection(-1);
            } else if (e.key === 'Enter') {
                e.preventDefault();
                if (currentResults.length > 0) {
                    const idx = selectedIndex >= 0 ? selectedIndex : 0;
                    jumpToPage(currentResults[idx].path);
                }
            } else if (e.key === 'Escape') {
                searchInput.value = '';
                hideResults();
            }
        });

        // 点击搜索框外部时收起结果列表
        document.addEventListener('click', (e) => {
            if (!searchInput.parentElement.contains(e.target)) hideResults();
        });
    }

    // 懒加载全部 MD 文件并提取纯文本（只加载一次并缓存）
    function ensureContentIndex() {
        if (contentIndexPromise) return contentIndexPromise;

        contentIndexPromise = Promise.all(
            pagesIndex.map(page =>
                fetch(page.path)
                    .then(res => res.ok ? res.text() : '')
                    .then(text => ({ path: page.path, text: stripMarkdown(text) }))
                    .catch(() => ({ path: page.path, text: '' }))
            )
        ).then(list => {
            contentIndex = list;
            // 若用户此时已经输入了关键词，用新的全文索引再搜一次
            if (searchInput.value.trim()) performSearch(searchInput.value);
        });

        return contentIndexPromise;
    }

    // 粗粒度去除 Markdown 标记，得到用于全文匹配的纯文本
    function stripMarkdown(md) {
        return md
            .replace(/```[\s\S]*?```/g, ' ')          // 代码块
            .replace(/`([^`]*)`/g, '$1')               // 行内代码
            .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')     // 图片
            .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')   // 链接保留文字
            .replace(/^#{1,6}\s+/gm, '')               // 标题符号
            .replace(/[>*_~#|\-]/g, ' ')               // 其他常见标记符号
            .replace(/\s+/g, ' ')
            .trim();
    }

    // 执行搜索：先匹配标题（优先级最高），再匹配正文
    function performSearch(rawKeyword) {
        const keyword = rawKeyword.trim().toLowerCase();
        if (!keyword) {
            hideResults();
            currentResults = [];
            return;
        }

        // 5.1 标题匹配
        const titleMatches = [];
        pagesIndex.forEach(page => {
            const title = page.title.toLowerCase();
            if (title.includes(keyword)) {
                titleMatches.push({
                    ...page,
                    score: title.startsWith(keyword) ? 0 : 1
                });
            }
        });
        titleMatches.sort((a, b) =>
            a.score - b.score || a.title.localeCompare(b.title, 'zh')
        );

        // 5.2 正文匹配（排除标题已命中的页面）
        const contentMatches = [];
        if (contentIndex) {
            contentIndex.forEach(item => {
                if (titleMatches.some(t => t.path === item.path)) return;
                const idx = item.text.toLowerCase().indexOf(keyword);
                if (idx !== -1) {
                    const page = pagesIndex.find(p => p.path === item.path);
                    contentMatches.push({
                        ...page,
                        snippet: makeSnippet(item.text, idx, keyword)
                    });
                }
            });
        }

        currentResults = [...titleMatches, ...contentMatches].slice(0, 12);
        selectedIndex = -1;
        renderResults(keyword);
    }

    // 截取关键词前后一小段文字作为预览
    function makeSnippet(text, idx, keyword) {
        const start = Math.max(0, idx - 24);
        const end = Math.min(text.length, idx + keyword.length + 36);
        return (start > 0 ? '…' : '') +
               text.slice(start, end) +
               (end < text.length ? '…' : '');
    }

    // 渲染搜索结果下拉列表
    function renderResults(keyword) {
        searchResults.innerHTML = '';

        if (currentResults.length === 0) {
            const li = document.createElement('li');
            li.className = 'wiki-search-empty';
            li.textContent = contentIndex ? '未找到相关页面' : '正在搜索全文…';
            searchResults.appendChild(li);
            showResults();
            return;
        }

        currentResults.forEach((result, i) => {
            const li = document.createElement('li');
            const a = document.createElement('a');
            a.href = '#';
            a.innerHTML =
                `<span class="wiki-search-result-title">${highlight(result.title, keyword)}</span>` +
                (result.breadcrumb.length
                    ? `<span class="wiki-search-result-path">${result.breadcrumb.map(escapeHtml).join(' / ')}</span>`
                    : '') +
                (result.snippet
                    ? `<span class="wiki-search-result-snippet">${highlight(result.snippet, keyword)}</span>`
                    : '');

            a.addEventListener('mouseenter', () => setSelected(i));
            a.addEventListener('click', (e) => {
                e.preventDefault();
                jumpToPage(result.path);
            });

            li.appendChild(a);
            searchResults.appendChild(li);
        });

        showResults();
    }

    // 跳转到指定页面：展开父级目录 → 高亮 → 加载文档
    function jumpToPage(filePath) {
        const page = pagesIndex.find(p => p.path === filePath);
        if (!page) return;

        // 展开目标页面所在的全部父级分类
        let subMenu = page.linkEl.closest('.sub-menu');
        while (subMenu) {
            subMenu.classList.add('open');
            const folderTitle = subMenu.parentElement.querySelector(':scope > .folder-title');
            if (folderTitle) folderTitle.classList.add('expanded');
            subMenu = subMenu.parentElement.closest('.sub-menu');
        }

        // 与点击侧边栏一致：高亮并加载
        navList.querySelectorAll('a').forEach(link => link.classList.remove('active'));
        page.linkEl.classList.add('active');
        loadMarkdown(filePath);
        page.linkEl.scrollIntoView({ block: 'nearest' });

        // 收起搜索框
        searchInput.value = '';
        hideResults();
        searchInput.blur();
    }

    // ===== 小工具 =====

    function moveSelection(delta) {
        if (currentResults.length === 0) return;
        setSelected(
            (selectedIndex + delta + currentResults.length) % currentResults.length
        );
    }

    function setSelected(i) {
        selectedIndex = i;
        const links = searchResults.querySelectorAll('a');
        links.forEach((a, idx) => a.classList.toggle('selected', idx === i));
        if (links[i]) links[i].scrollIntoView({ block: 'nearest' });
    }

    function showResults() {
        searchResults.classList.add('open');
    }

    function hideResults() {
        searchResults.classList.remove('open');
        selectedIndex = -1;
    }

    function escapeHtml(str) {
        return str.replace(/[&<>"']/g, s => ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#39;'
        }[s]));
    }

    // 转义 HTML 后把关键词包成 <mark> 高亮
    function highlight(text, keyword) {
        const safe = escapeHtml(text);
        const escapedKw = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return safe.replace(new RegExp(escapedKw, 'gi'), m => `<mark>${m}</mark>`);
    }
});
