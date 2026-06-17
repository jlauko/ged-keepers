// Generic cluster class
export default class Clusters {

    constructor() {
        this.groups = {};  // groups loaded from JSON file
        this.ClusterArray = [];
        this.JData = "";
        this.nodes = null;  // store reference to nodes
        this.type = "";
    }
// --------------------------------------------------------------------------------------------- 
// This function (init) will load the group definitions from a JSON file ---------------------
// and then assign each node to its group based on the propertyname passed in -----------------
// ---------------------------------------------------------------------------------------------
    async init(JData, nodes, propertyname, userId, network,boxWidth) { 
//        console.log("arguments:", arguments );
        this.type = propertyname;
        this.groups = JData;
        this.nodes = nodes;  // store nodes for birth year extraction in Create()
        console.log("Initializing Clusters...",this.type, JData);
        this.groups = JData;
        console.log("Groups loaded:", this.groups);

        const updates = []; 
        nodes.forEach(node => {
            for (const [groupName, memberIds] of Object.entries(this.groups)) {
                if (memberIds.includes(node.id)) {
                    updates.push({ id: node.id, [propertyname]: groupName });
                //    nodes.update({ id: node.id, [propertyname]: groupName });
                    break;
                }
            }
        });
        if (updates.length > 0) {
            nodes.update(updates);
        }
        this.Get(userId, network,boxWidth);
        
    }

// ---------------------------------------------------------------------------------------------
// This function (Get) will first attempt to fetch existing clusters from the server -----------
// If the server returns an error or no clusters are found, it will create new ones ------------
// If new clusters need to be generated they will be based on the network and Group passed in --
// ---------------------------------------------------------------------------------------------
    Get(userId, network,boxWidth) {
//        console.log("Fetching clusters:", userId);
        try {
            // first attempt to load from server
            const res = fetch(`/clusters/${userId}`);
            if (!res.ok) {
                // load from server failed, now try and create new clusters
                console.log("Failed to load clusters:", this.type);
                this.Create(network,boxWidth);
                return;
            } else {
                // load from server succeeded, now parse and use
                ClusterArray = res.json();
                console.log("Loaded Clusters from server:", ClusterArray);
                if (!ClusterArray || ClusterArray.length === 0) {
                    // if there are no clusters, create new ones
                    console.log("No Clusters found, calculating new ones...");
                    this.Create(network,boxWidth);
                }
            }
            return;
        } catch (err) {
            console.error("Error fetching clusters:", err);
            this.Create(network,boxWidth);
        }
        return;
    }
// ---------------------------------------------------------------------------------------------
// This function (Create) will generate clusters based on the Group (this.groups) passed in in the init function -------
// ---------------------------------------------------------------------------------------------    

    async Create(network,boxWidth) {
        // This function creates clusters (using only nodes within the network) for each group using the DBSCAN clustering algorithm
        // The result is an array of cluster objects with {id, groupName, nodeIds, positions}

        // -----------------------------------------------------------------------
        // For each group, get node positions from network and run DBSCAN clustering
        // -----------------------------------------------------------------------
        console.log("Creating Clusters...", this.groups);
        this.ClusterArray.length = 0;  // reset existing clusters   
        for (const [groupName, nodeIds] of Object.entries(this.groups)) {
            // ----------------------------------------
            // --- For each group, create clusters ----
            // ---- cycling through each group name ----
            // ----------------------------------------
            // Get positions for nodes (IDs) that exist in the network for each group
            const posObj = network.getPositions(nodeIds);
            // Build array of {id, x, y} for valid nodes
            const validNodes = nodeIds
                .filter(id => posObj[id]) // only nodes in network
                .map(id => ({ id, ...posObj[id] }));

            // skip groups with less than 3 nodes
            if (validNodes.length < 3) continue;

            // Extract positions for DBSCAN
            const positions = validNodes.map(n => ({ id: n.id, x: n.x, y: n.y }));

            // Run DBSCAN clustering
            const clustersObj = dbscan(positions, 850, 3);  // for each group, cluster nodes based on proximity
            // Convert clustersObj to array
            const clusters = Object.values(clustersObj);

            // Assign names to each cluster, group - letters A, B, C, etc.
            const names = nameClusters(groupName, clusters);

            let half = boxWidth/2;
            for (const [i, clusterPoints] of clusters.entries()) {
                // ------------------------------------------
                // now for each cluster within the group  
                // ------------------------------------------
                const pts = []; 
                // ------------------------------------------
                // compute convex hull for each cluster for drawing
                // ------------------------------------------
                clusterPoints.forEach(p => {
                    pts.push({x:p.x - half, y:p.y});   // padded hull around nodes in group
                    pts.push({x:p.x + half, y:p.y});   // create 2 points for each node at +- 1/2 boxwidth
                });

                // Calculate the centroid
                let sumX = 0, sumY = 0;
                pts.forEach(p => {
                    sumX += p.x;
                    sumY += p.y;
                });
                const cx = (sumX / pts.length);  // centroid of the group using node positions
                const cy = (sumY / pts.length);

                // Compute convex hull in network coords
                const hull = convexHull(pts);              // create hull or shell
                const paddingx = 100;       // pad the hull so that it encapsulates more of each node 
                const paddingy = 50;
                // Compute padded hull
                const paddedHull = padHull(hull,paddingx, paddingy);

                // Map cluster positions back to node IDs
                const clusterNodeIds = clusterPoints.map(p => p.id); 

                // Calculate min and max birth years for nodes in this cluster
                const birthYears = clusterNodeIds
                    .map(nodeId => this.extractBirthYear(nodeId))
                    .filter(year => year !== null);
                const minBirthYear = birthYears.length > 0 ? Math.min(...birthYears) : null;
                const maxBirthYear = birthYears.length > 0 ? Math.max(...birthYears) : null;

                // Create ClusterID from groupName + birth year range
                const clusterID = `${groupName}_${minBirthYear}_${maxBirthYear}`;

//                const info = await this.getClusterInfo(names[i],groupName, minBirthYear, maxBirthYear) 
                const info = `Cluster: ${names[i]} from ${minBirthYear} to ${maxBirthYear} `;
                // ---------------------------------------------------------
                // Now store information about this cluster in ClusterArray
                // ---------------------------------------------------------
                this.ClusterArray.push({
                    clusterID: clusterID,
                    id: names[i],
                    groupName: groupName,
                    nodeIds: clusterNodeIds,
                    positions: paddedHull,
                    minBirthYear: minBirthYear,
                    maxBirthYear: maxBirthYear,
                    info: info,
                    centroid: {x: cx, y: cy}
                });
            };
        }

        console.log("Created Clusters:", this.ClusterArray);  
        return;

        function nameClusters(baseName, clusters) {
            if (clusters.length === 1) return [baseName];
            const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
            return clusters.map((_, i) => `${baseName}-${letters[i]}`);
        }
    
        // ---------------------------------- DBSCAN Clustering Algorithm ------------------------
        function dbscan(points, eps, minPts = 3) {
            const visited = new Set();
            const clustered = new Array(points.length).fill(null);
            let clusterId = 0;

            function regionQuery(i) {
                const neighbors = [];
                for (let j = 0; j < points.length; j++) {
                    const dx = points[i].x - points[j].x;
                    const dy = points[i].y - points[j].y;
                    const dist = Math.sqrt(dx*dx + dy*dy);
                    if (dist <= eps) neighbors.push(j);
                }
                return neighbors;
            }

            for (let i = 0; i < points.length; i++) {
                if (visited.has(i)) continue;
                visited.add(i);

                const neighbors = regionQuery(i);
                if (neighbors.length < minPts) {
                    continue; // noise or too small
                }

                // create a new cluster
                const stack = [...neighbors];
                clustered[i] = clusterId;

                while (stack.length) {
                    const idx = stack.pop();
                    if (!visited.has(idx)) {
                        visited.add(idx);
                        const neighbors2 = regionQuery(idx);
                        if (neighbors2.length >= minPts) {
                            stack.push(...neighbors2);
                        }
                    }
                    if (clustered[idx] === null) {
                        clustered[idx] = clusterId;
                    }
                }       
                clusterId++;
            }

            // Build final clusters
            const clusters = {};
            for (let i = 0; i < points.length; i++) {
                if (clustered[i] !== null) {
                    const id = clustered[i];
                    if (!clusters[id]) clusters[id] = [];
                    clusters[id].push(points[i]);
                }
            }
            return clusters;
        }
        function padHull(hull, paddingX, paddingY) {
            const padded = [];
            hull.forEach((pt, i) => {
                const prev = hull[(i - 1 + hull.length) % hull.length];
                const next = hull[(i + 1) % hull.length];

                // compute normal
                const dx = next.y - prev.y;
                const dy = -(next.x - prev.x);
                const len = Math.hypot(dx, dy) || 1;

                padded.push({
                    x: pt.x + (dx / len) * paddingX,
                    y: pt.y + (dy / len) * paddingY
                });
            });
            return padded;
        }
            
        function convexHull(points) {            
            points = points.slice().sort((a, b) => a.x - b.x || a.y - b.y);
            const cross = (o, a, b) =>
                (a.x - o.x) * (b.y - o.y) -
                (a.y - o.y) * (b.x - o.x);

            const lower = [];
            for (const p of points) {
                while (lower.length >= 2 &&
                    cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
                    lower.pop();
                }
                lower.push(p);
            }
            const upper = [];
            for (let i = points.length - 1; i >= 0; i--) {
                const p = points[i];
                while (upper.length >= 2 &&
                    cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
                    upper.pop();
                }
                upper.push(p);
            }
            upper.pop();
            lower.pop();
            return lower.concat(upper);
        }

    }
// ---------------------------------------------------------------------------------------------
// Draw function to render clusters on canvas -----------------------------------------------
// ---------------------------------------------------------------------------------------------    
    Draw(ctx, groupColors, highlightedClusterId)
    {
        //console.log("Call to Draw Clusters -------------------------");
        if (!Array.isArray(this.ClusterArray)) {
            console.error("ClusterArray is not an array:", this.ClusterArray);
            return;
        } 
//        console.log("Drawing  -------------------------", highlightedClusterId);
        for (const cluster of this.ClusterArray) {
            const { id, groupName, positions } = cluster;

            if (!positions || positions.length < 2) continue; // need at least 3 points for a shape
    //        if (highlightedClusterId !== null && id !== highlightedClusterId) continue; // only draw the highlighted cluster

            // Draw group name at centroid
//            let sumX = 0, sumY = 0;
//            positions.forEach(p => {
//                sumX += p.x;
//                sumY += p.y;
//            });
            const cx = cluster.centroid.x; //(sumX / positions.length);  // centroid of the group using node positions
            const cy = cluster.centroid.y; //(sumY / positions.length); 

            // Begin canvas shape
            ctx.beginPath();

            for (let i = 0; i < positions.length; i++) {
                const prev = positions[(i - 1 + positions.length) % positions.length];
                const curr = positions[i];
                const next = positions[(i + 1) % positions.length];
                const mid1 = {
                    x: (prev.x + curr.x)/2,
                    y: (prev.y + curr.y)/2
                };
                const mid2 = {
                    x: (curr.x + next.x)/2,
                    y: (curr.y + next.y)/2
                };

                if (i === 0) ctx.moveTo(mid1.x, mid1.y);
                ctx.quadraticCurveTo(curr.x, curr.y, mid2.x, mid2.y);
 //           console.log("Hull point:", curr.x, curr.y); 
            }

            ctx.closePath();

            // Style for highlighted cluster
            const baseName = getBaseGroupName(groupName);
            const color = groupColors[baseName] || "rgba(100,150,255,0.15)";

//            console.log("Cluster color for ", baseName, "(", color, ")");
            ctx.fillStyle = color;
 
            if (highlightedClusterId != id) {
                ctx.strokeStyle = color.replace("0.28", "0.45"); // slightly darker outline
                ctx.lineWidth = 5;
//                console.log("Drawing unhighlighted cluster:");
            } else {
                ctx.strokeStyle = "red";
                ctx.lineWidth = 8;
 //               console.log("Drawing highlighted cluster:", highlightedClusterId);
            }

            ctx.fill();
            ctx.stroke();        

            // Draw label in screen space (no scaling)
            const computeLabelPosition = (points) => {
                const minX = Math.min(...points.map(n => n.x));
                const maxX = Math.max(...points.map(n => n.x));
                const minY = Math.min(...points.map(n => n.y));
                const maxY = Math.max(...points.map(n => n.y));

                let nodepos = network.getPositions(cluster.nodeIds);

                let boxWidth = 450;
                let boxHeight = 100;
                const step = 20;
                let bestPoint = {x: 0, y: 0};
                let bestDist = -Infinity;
                let bestScore = -Infinity;
                let dist = Infinity;
                const scale = network.getScale();

                ctx.font = "20px Arial";
                const textMetrics = ctx.measureText(groupName);
            //    const labelWidth = textMetrics.width;
            //    const labelHeight = 20; // approximate height for 20px font
                // computing the size of the text label in world coordinates so we can check for overlaps with nodes in the cluster
                const labelWidth = textMetrics.width / scale;
                const labelHeight = 20 / scale;
            //    console.log("Label dimensions:", labelWidth, labelHeight);
                let found = false;

                for (let y = minY; y <= maxY; y += step) {
                    for (let x = minX; x <= maxX; x += step) {
                        if (this.pointInPolygon(x, y, points)) {
                            // point must fall within the cluster polygon, and then we will score it based on distance to nearest node edge and distance to centroid, while also checking that the label box does not overlap with any nodes
                            const labelBox = {
                                left: x - labelWidth/2, 
                                right: x + labelWidth/2,
                                top: y - labelHeight,
                                bottom: y    
                            };
                            let minDist = Infinity;
                            const dxc = x - cluster.centroid.x;
                            const dyc = y - cluster.centroid.y;
                            const distanceToCentroid = Math.sqrt(dxc * dxc + dyc * dyc);
                            //Find the point that has the greatest distance from the edge of the cluster
                            let covered = false;
                            // loop through nodes in the cluster and check distance to label box, if the label box overlaps with any node, skip this point for label placement
                            for (const p of Object.values(nodepos)) {
                                const nodeBox = {
                                    left: p.x - boxWidth/2,
                                    right: p.x + boxWidth/2,
                                    top: p.y - boxHeight/2,
                                    bottom: p.y + boxHeight/2
                                };
                                // does the node and label overlap? if so, skip this point for label placement
                                covered = labelBox.left < nodeBox.right &&
                                          labelBox.right > nodeBox.left &&
                                          labelBox.top < nodeBox.bottom &&
                                          labelBox.bottom > nodeBox.top;
                                
                                if (covered) {
                                    break; // if the label box overlaps with any node, skip this point for label placement
                                }

                                // if not covered, calculate distance from label point to node edge
                                const dx = p.x - x;
                                const dy = p.y - y;
                                dist = Math.sqrt(dx*dx + dy*dy); // distance from node edge
                                if (dist < minDist) minDist = dist;
                                
                            };  // end of node loop
                            // for this x,y point on the grid, is the distance
                            // to the nearest node greater than the best distance we've found so far?
                            // we want the largest distance that does not intersect with any nodes, 
                            // and also favors points closer to the centroid of the cluster
                            let score = minDist - distanceToCentroid * 1; // simple scoring function that favors points farther from edges and closer to centroid
                            if (score > bestScore && !covered) {
                                // if the score is better, and the point is not behind a node, store this point as the best point for the label
                                bestScore = score;
                                bestPoint = {x, y};
                                found = true;
                            }
                        }
                    } // increment to the next x point on the grid
                }// increment to the next y point on the grid
                if (!found) {
                    // if we didn't find any point that is not covered by a node, just place the label above the centroid
                    return {x: cx, y: cy - 10};
                }
                return {x: bestPoint.x, y: bestPoint.y - 10}; // position label above the closest point in the cluster
            }

        //    console.log("Computing label position for cluster:", id, "centroid:", cx, cy);
            let labelpos = {x: cx, y: cy};
            // computeLabelPosition finds the optimal placement for the cluster label
            // However, it is computationally expensive, so for now we will just place the label at the centroid of the cluster, but this can be improved in the future by implementing the computeLabelPosition function which checks for points within the cluster polygon and finds the point that is farthest from any node edges while also being reasonably close to the centroid, and places the label there instead of the centroid. This will help avoid cases where the centroid is covered by a node and the label is not visible.
        //    labelpos = computeLabelPosition(positions);
        //    console.log("Label position for cluster", id, ":", labelpos);

            ctx.save();
            
            const t = ctx.getTransform();
            const sx = t.a * labelpos.x + t.e;   // apply transform manually
            const sy = t.d * labelpos.y + t.f;
            
            // Reset transform so text is not scaled
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.font = "20px Arial";
            ctx.textAlign = "center";
            ctx.fillStyle = "black";
            if (highlightedClusterId !== null) {
                ctx.fillStyle = "red";
            }
            ctx.fillText(groupName, sx, sy);
            ctx.restore();

        }

        function getBaseGroupName(groupName) {
            // Matches "-A", "-B", "-C", ..., "-Z"
            const match = groupName.match(/^(.*?)-[A-Z]$/);
            return match ? match[1] : groupName;
        }
    }
    insideClusters(x, y)
    {
        // returns the cluster ID if point (x,y) is inside any cluster polygon, else null
        // console.log("Checking point inside clusters:", x, y);
        if (!Array.isArray(this.ClusterArray)) {
            console.error("insideClusters: ClusterArray is not an array:", this.ClusterArray);
            return null;
        }

        for (const cluster of this.ClusterArray) {
            const poly = cluster.positions;
            if (!poly || poly.length < 3) continue;
            if (this.pointInPolygon(x, y, poly)) {
//                console.log ("found cluster :", cluster.id);
                return cluster.id;
            }
        }
//        console.log("No cluster found at:", x, y);

        return null;
    }
        // Ray-casting point-in-polygon
    pointInPolygon(px, py, polygon) {
        if (!polygon || polygon.length < 3) return false;
        let inside = false;
        for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
            const xi = polygon[i].x, yi = polygon[i].y;
            const xj = polygon[j].x, yj = polygon[j].y;
            const intersect = ((yi > py) !== (yj > py)) &&
                (px < (xj - xi) * (py - yi) / (yj - yi) + xi);
            if (intersect) inside = !inside;
        }
        return inside;
    }

    extractBirthYear(nodeId) {
        if (!this.nodes) return null;
        const node = this.nodes.get(nodeId);
        if (!node || !node.birthdatestring) return null;
        
        // Extract year from birthdatestring (format: "YYYY" or "DD MMM YYYY" etc)
        const match = node.birthdatestring.match(/\b(1\d{3}|2\d{3})\b/);
        return match ? parseInt(match[0], 10) : null;
    }

    GetInfo(clusterId) {
        const cluster = this.ClusterArray.find(c => c.id === clusterId);
        if (!cluster) return null;
        // Return the minimum birth year for the cluster (or null if not available)
        return cluster.info !== undefined ? cluster.info : null;
    }
    GetClusterName(clusterId) {
        const cluster = this.ClusterArray.find(c => c.id === clusterId);
        if (!cluster) return null;
        return cluster.groupName;
    }
    Exist(clusterId) {
        const cluster = this.ClusterArray.find(c => c.id === clusterId);
        if (!cluster) return false;
        return true;
    }
    GetClusterType() {
        return this.type;
    }
    GetCentroid(clusterId) {
        const cluster = this.ClusterArray.find(c => c.id === clusterId);
        if (!cluster) return null;
        return cluster.centroid;
    }
    GetClusterMinDate(clusterId) {
        const cluster = this.ClusterArray.find(c => c.id === clusterId);
        if (!cluster) return null;
        return cluster.minBirthYear;
    }
    GetClusterMaxDate(clusterId) {
        const cluster = this.ClusterArray.find(c => c.id === clusterId);
        if (!cluster) return null;
        return cluster.maxBirthYear;
    }   
    GenerateInfoString(clusterId) {
        const cluster = this.ClusterArray.find(c => c.id === clusterId);
        if (!cluster) return "Cluster not found.";  
        return cluster.info || "No additional info available."; 
    }

    async getClusterInfo(ClusterId, place, startYear, endYear) {
        const query = `${place} history ${startYear} to ${endYear}`;

        // Step 1: Wikipedia baseline
        const wikiUrl = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(query)}`;
        let wikiData = null;
        try {
            const wikiResponse = await fetch(wikiUrl);
            if (wikiResponse.ok) {
                wikiData = await wikiResponse.json();
            }
        } catch (err) {
            console.error("Wikipedia fetch failed:", err);
        }

        // Step 2: AI enrichment (pseudo-code, replace with your AI endpoint)
        let aiText = null;
        try {
            const aiResponse = await fetch("https://your-ai-endpoint.com/v1/chat/completions", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": "Bearer YOUR_API_KEY"
            },
            body: JSON.stringify({
                model: "gpt-4",
                messages: [{
                role: "user",
                content: `Provide historical context for ${place} from ${startYear} to ${endYear}. 
                            Then expand into specifics: towns, surnames, migration patterns, and cultural notes.`
                }]
            })
            });
            const aiData = await aiResponse.json();
            aiText = aiData.choices[0].message.content;
        } catch (err) {
            console.error("AI fetch failed:", err);
        }

        console.log("query:", query);   
        console.log("wikiData:", wikiData);
        if (wikiData) 
        {    
            console.log("extract:", wikiData.extract);

            this.ClusterArray.push({
                id: ClusterId,
                info: wikiData.extract
            });
            return {
            wiki: wikiData ? {
            title: wikiData.title,
            description: wikiData.description,
            extract: wikiData.extract,
            url: wikiData.content_urls.desktop.page
            } : null,
            ai: aiText
        };
        } else 
        {
            return null;   
        }
        // Step 3: Return combined info

    }

}   